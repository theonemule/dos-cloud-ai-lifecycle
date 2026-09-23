const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { Pool } = require("pg");

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
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
`;

function nowIso() {
  return new Date().toISOString();
}

function toPgPlaceholders(sql) {
  let index = 0;
  let out = "";
  let quote = null;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      out += ch;
      if (ch === quote) {
        if (sql[i + 1] === quote) {
          out += sql[++i];
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }

    if (ch === "?") {
      index++;
      out += "$" + index;
    } else {
      out += ch;
    }
  }
  return out;
}

function createSqliteDatabase(filename, options = {}) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const raw = new DatabaseSync(filename);
  const journalMode = String(options.journalMode || process.env.DOS_CLOUD_SQLITE_JOURNAL_MODE || "WAL").toUpperCase();
  const busyTimeoutMs = Number(options.busyTimeoutMs ?? process.env.DOS_CLOUD_SQLITE_BUSY_TIMEOUT_MS ?? 10000);

  raw.exec("PRAGMA busy_timeout = " + Math.floor(busyTimeoutMs) + ";");
  raw.exec("PRAGMA journal_mode = " + journalMode + ";");
  raw.exec("PRAGMA foreign_keys = ON;");
  raw.exec(SCHEMA_SQL);

  return {
    kind: "sqlite",
    filename,
    raw,
    prepare(sql) {
      return raw.prepare(sql);
    },
    async exec(sql) {
      raw.exec(sql);
    },
    async run(sql, ...params) {
      const result = raw.prepare(sql).run(...params);
      return { changes: Number(result.changes || 0), lastInsertRowid: result.lastInsertRowid };
    },
    async get(sql, ...params) {
      return raw.prepare(sql).get(...params) || null;
    },
    async all(sql, ...params) {
      return raw.prepare(sql).all(...params);
    },
    async ping() {
      raw.prepare("SELECT 1 AS ready").get();
      return true;
    },
    async close() {
      raw.close();
    },
  };
}

async function createPostgresDatabase(connectionString, options = {}) {
  let poolOptions;

  if (connectionString) {
    poolOptions = {
      connectionString,
      ssl: options.ssl ?? (process.env.DOS_CLOUD_DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }),
    };
  } else {
    const host = options.host || process.env.DOS_CLOUD_DATABASE_HOST;
    const database = options.database || process.env.DOS_CLOUD_DATABASE_NAME || "doscloud";
    const user = options.user || process.env.DOS_CLOUD_DATABASE_USER;
    const port = Number(options.port || process.env.DOS_CLOUD_DATABASE_PORT || 5432);
    const managedIdentityClientId = options.managedIdentityClientId || process.env.AZURE_CLIENT_ID;

    if (!host || !user) {
      throw new Error("PostgreSQL managed-identity configuration requires DOS_CLOUD_DATABASE_HOST and DOS_CLOUD_DATABASE_USER");
    }

    const { DefaultAzureCredential } = require("@azure/identity");
    const { entraTokenProvider } = await import("@azure/postgresql-auth");
    const credential = new DefaultAzureCredential(
      managedIdentityClientId ? { managedIdentityClientId } : {}
    );

    poolOptions = {
      host,
      database,
      user,
      port,
      password: entraTokenProvider(credential),
      ssl: options.ssl ?? { rejectUnauthorized: false },
    };
  }

  const pool = new Pool({
    ...poolOptions,
    max: Number(process.env.DOS_CLOUD_DATABASE_POOL_MAX || 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  await pool.query("SELECT 1");
  await pool.query(SCHEMA_SQL);

  return {
    kind: "postgres",
    pool,
    async exec(sql) {
      await pool.query(sql);
    },
    async run(sql, ...params) {
      const result = await pool.query(toPgPlaceholders(sql), params);
      return { changes: result.rowCount || 0 };
    },
    async get(sql, ...params) {
      const result = await pool.query(toPgPlaceholders(sql), params);
      return result.rows[0] || null;
    },
    async all(sql, ...params) {
      const result = await pool.query(toPgPlaceholders(sql), params);
      return result.rows;
    },
    async ping() {
      await pool.query("SELECT 1");
      return true;
    },
    async close() {
      await pool.end();
    },
  };
}

function openDatabase(input, options = {}) {
  const connectionString =
    options.connectionString ||
    process.env.DOS_CLOUD_DATABASE_URL ||
    (typeof input === "string" && /^postgres(?:ql)?:\/\//i.test(input) ? input : null);
  const managedPostgres = Boolean(
    options.host ||
    process.env.DOS_CLOUD_DATABASE_HOST
  );

  if (connectionString || managedPostgres) {
    return createPostgresDatabase(connectionString, options);
  }

  const filename = typeof input === "string"
    ? input
    : options.filename || path.join(process.cwd(), "var", "doscloud.db");

  return createSqliteDatabase(filename, options);
}

module.exports = {
  openDatabase,
  nowIso,
  toPgPlaceholders,
  SCHEMA_SQL,
};
