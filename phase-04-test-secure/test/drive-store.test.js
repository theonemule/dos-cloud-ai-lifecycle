const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DriveStore } = require("../src/drive-store");

test("DriveStore provides DOS-style case-insensitive file semantics", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dos-drive-"));
  const drive = new DriveStore(root);
  try {
    await drive.mkdir("C:\\SAVE");
    let opened = await drive.open("C:\\SAVE\\GAME.DAT", "w+");
    await drive.write(opened.handle, Buffer.from("HELLO DOS"), 0);
    await drive.close(opened.handle);

    opened = await drive.open("c:\\save\\game.dat", "r");
    const read = await drive.read(opened.handle, 64, 0);
    assert.equal(Buffer.from(read.payload).toString(), "HELLO DOS");
    await drive.close(opened.handle);

    const listed = await drive.list("C:\\SAVE");
    assert.equal(listed.entries[0].name, "GAME.DAT");
  } finally {
    await drive.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("DriveStore rejects path traversal", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dos-drive-"));
  const drive = new DriveStore(root);
  try {
    await assert.rejects(() => drive.stat("C:\\..\\..\\etc\\passwd"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
