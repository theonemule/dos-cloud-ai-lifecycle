const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const JOURNAL_MODES = new Set(["WAL", "DELETE", "TRUNCATE", "PERSIST", "MEMORY", "OFF"]);

function resolveJournalMode(value) {
  const mode = String(value || process.env.DOS_CLOUD_SQLITE_JOURNAL_MODE || "WAL").trim().toUpperCase();
  if (!JOURNAL_MODES.has(mode)) {
    throw new Error("unsupported SQLite journal mode: " + mode);
  }
  return mode;
}

function openDatabase(filename, options = {}) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  const journalMode = resolveJournalMode(options.journalMode);
  const busyTimeoutMs = Number(options.busyTimeoutMs ?? process.env.DOS_CLOUD_SQLITE_BUSY_TIMEOUT_MS ?? 10000);
  if (!Number.isFinite(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60000) {
    throw new Error("invalid SQLite busy timeout");
  }
  const synchronous = journalMode === "WAL" ? "NORMAL" : "FULL";
  db.exec(`
    PRAGMA busy_timeout = ${Math.floor(busyTimeoutMs)};
    PRAGMA journal_mode = ${journalMode};
    PRAGMA synchronous = ${synchronous};
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      subtitle TEXT,
      publisher TEXT,
      year INTEGER,
      genre_json TEXT NOT NULL,
      manifest_path TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS user_games (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      version TEXT NOT NULL,
      install_path TEXT NOT NULL,
      installed_at TEXT NOT NULL,
      last_played_at TEXT,
      PRIMARY KEY (user_id, game_id)
    );

    CREATE TABLE IF NOT EXISTS launch_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_id TEXT REFERENCES games(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK(mode IN ('game','console')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oidc_identities (
      issuer TEXT NOT NULL,
      subject TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email TEXT,
      email_verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_login_at TEXT NOT NULL,
      PRIMARY KEY (issuer, subject),
      UNIQUE (user_id, issuer)
    );

    CREATE TABLE IF NOT EXISTS oidc_flows (
      state_hash TEXT PRIMARY KEY,
      issuer TEXT NOT NULL,
      code_verifier TEXT NOT NULL,
      nonce TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      link_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_launch_user ON launch_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_oidc_identities_user ON oidc_identities(user_id);
    CREATE INDEX IF NOT EXISTS idx_oidc_flows_expiry ON oidc_flows(expires_at);
  `);
  return db;
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = { openDatabase, nowIso, resolveJournalMode };
