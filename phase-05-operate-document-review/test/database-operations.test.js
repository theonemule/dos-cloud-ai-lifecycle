const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDatabase, toPgPlaceholders } = require("../src/platform/database");

test("database: local development fallback uses SQLite WAL", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dos-cloud-sqlite-"));
  const db = openDatabase(path.join(root, "state.db"), { journalMode: "WAL" });
  try {
    const row = db.prepare("PRAGMA journal_mode").get();
    assert.equal(String(row.journal_mode).toLowerCase(), "wal");
    assert.equal(db.kind, "sqlite");
  } finally {
    await db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("database: PostgreSQL adapter translates positional placeholders", () => {
  assert.equal(
    toPgPlaceholders("SELECT * FROM users WHERE id = ? AND username = ?"),
    "SELECT * FROM users WHERE id = $1 AND username = $2"
  );
  assert.equal(
    toPgPlaceholders("SELECT '?' AS literal, id FROM users WHERE id = ?"),
    "SELECT '?' AS literal, id FROM users WHERE id = $1"
  );
});
