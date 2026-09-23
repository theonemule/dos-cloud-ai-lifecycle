const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDatabase, resolveJournalMode } = require("../src/platform/database");

test("database: local default uses WAL", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dos-cloud-wal-"));
  const db = openDatabase(path.join(root, "state.db"), { journalMode: "WAL" });
  try {
    const row = db.prepare("PRAGMA journal_mode").get();
    assert.equal(String(row.journal_mode).toLowerCase(), "wal");
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("database: network-filesystem deployment can use rollback journal", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dos-cloud-delete-"));
  const db = openDatabase(path.join(root, "state.db"), { journalMode: "DELETE", busyTimeoutMs: 10000 });
  try {
    const journal = db.prepare("PRAGMA journal_mode").get();
    const timeout = db.prepare("PRAGMA busy_timeout").get();
    assert.equal(String(journal.journal_mode).toLowerCase(), "delete");
    assert.equal(Number(timeout.timeout), 10000);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("database: unsupported journal modes fail closed", () => {
  assert.throws(() => resolveJournalMode("not-a-mode"), /unsupported SQLite journal mode/);
});
