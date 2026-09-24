const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const AdmZip = require("adm-zip");
const { extractArchivePortable, validateArchive } = require("../src/platform/library");

test("library: portable extraction does not require chmod", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dos-cloud-azure-files-"));
  const zip = new AdmZip();
  zip.addFile("GAME/START.BAT", Buffer.from("@echo off\r\nGAME.EXE\r\n"));
  zip.addFile("GAME/DATA/README.TXT", Buffer.from("hello"));

  validateArchive(zip);

  const originalChmod = fs.chmodSync;
  fs.chmodSync = () => {
    const err = new Error("chmod is not supported on this filesystem");
    err.code = "EPERM";
    throw err;
  };

  try {
    extractArchivePortable(zip, root);
  } finally {
    fs.chmodSync = originalChmod;
  }

  assert.equal(
    fs.readFileSync(path.join(root, "GAME", "START.BAT"), "utf8"),
    "@echo off\r\nGAME.EXE\r\n"
  );
  assert.equal(
    fs.readFileSync(path.join(root, "GAME", "DATA", "README.TXT"), "utf8"),
    "hello"
  );

  fs.rmSync(root, { recursive: true, force: true });
});

test("library: portable extraction keeps traversal protection", () => {
  const fakeZip = {
    getEntries() {
      return [{
        entryName: "../escape.txt",
        isDirectory: false,
        header: { size: 4 },
        getData() { return Buffer.from("nope"); },
      }];
    },
  };

  assert.throws(() => validateArchive(fakeZip), /unsafe archive path/);
});
