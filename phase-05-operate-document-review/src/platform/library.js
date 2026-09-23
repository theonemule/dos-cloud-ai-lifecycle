const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const AdmZip = require("adm-zip");
const { nowIso } = require("./database");

function fileSha256(filename) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filename, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let read;
    do {
      read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read) hash.update(buffer.subarray(0, read));
    } while (read);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function validateArchive(zip) {
  let expanded = 0;
  for (const entry of zip.getEntries()) {
    const name = entry.entryName.replaceAll("\\", "/");
    if (!name || name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.split("/").some(p => p === "..")) {
      throw Object.assign(new Error("unsafe archive path: " + entry.entryName), { statusCode: 400 });
    }
    expanded += Number(entry.header.size) || 0;
    if (expanded > 256 * 1024 * 1024) {
      throw Object.assign(new Error("archive expands beyond 256 MB limit"), { statusCode: 400 });
    }
  }
}

function createLibraryService({ db, catalog, packagesRoot, auth }) {
  async function getInstalled(userId, gameId) {
    return db.get("SELECT * FROM user_games WHERE user_id = ? AND game_id = ?", userId, gameId);
  }

  async function list(userId) {
    return (await catalog.listForUser(userId)).filter(g => g.installed);
  }

  async function install(user, gameId) {
    const manifest = catalog.get(gameId);
    const existing = await getInstalled(user.id, gameId);
    if (existing && existing.version === manifest.version) {
      return { installed: true, alreadyInstalled: true, game: catalog.publicGame(manifest, existing) };
    }
    if (existing && existing.version !== manifest.version) {
      throw Object.assign(
        new Error("a different version is already installed; explicit upgrade/repair is required to protect user saves"),
        { statusCode: 409 }
      );
    }

    const packageFile = path.join(packagesRoot, manifest.package.file);
    if (!fs.existsSync(packageFile)) {
      throw Object.assign(new Error("catalog package is unavailable on this server"), { statusCode: 503 });
    }
    const actualHash = fileSha256(packageFile);
    if (actualHash.toLowerCase() !== manifest.package.sha256.toLowerCase()) {
      throw Object.assign(new Error("catalog package checksum mismatch"), { statusCode: 500 });
    }

    const driveRoot = auth.userDriveRoot(user.id);
    const gamesRoot = path.join(driveRoot, "GAMES");
    fs.mkdirSync(gamesRoot, { recursive: true });
    const destination = path.join(gamesRoot, manifest.install.folder);

    if (fs.existsSync(destination) && !existing) {
      throw Object.assign(new Error("install directory already exists outside the library record"), { statusCode: 409 });
    }

    const staging = destination + ".install-" + Date.now();
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });

    try {
      const zip = new AdmZip(packageFile);
      validateArchive(zip);
      zip.extractAllTo(staging, true);
      if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
      fs.renameSync(staging, destination);
    } catch (err) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw err;
    }

    const at = nowIso();
    await db.run(
      `INSERT INTO user_games(user_id,game_id,version,install_path,installed_at,last_played_at)
       VALUES (?,?,?,?,?,NULL)
       ON CONFLICT(user_id,game_id) DO UPDATE SET
         version=excluded.version,
         install_path=excluded.install_path,
         installed_at=excluded.installed_at`,
      user.id, gameId, manifest.version, "GAMES\\" + manifest.install.folder, at
    );

    const row = await getInstalled(user.id, gameId);
    return { installed: true, alreadyInstalled: false, game: catalog.publicGame(manifest, row) };
  }

  async function uninstall(user, gameId) {
    const row = await getInstalled(user.id, gameId);
    if (!row) return { installed: false };
    const manifest = catalog.get(gameId);
    const destination = path.join(auth.userDriveRoot(user.id), "GAMES", manifest.install.folder);
    fs.rmSync(destination, { recursive: true, force: true });
    await db.run("DELETE FROM user_games WHERE user_id = ? AND game_id = ?", user.id, gameId);
    return { installed: false };
  }

  async function markPlayed(userId, gameId) {
    if (gameId) {
      await db.run(
        "UPDATE user_games SET last_played_at = ? WHERE user_id = ? AND game_id = ?",
        nowIso(), userId, gameId
      );
    }
  }

  return { getInstalled, list, install, uninstall, markPlayed };
}

module.exports = { createLibraryService, fileSha256 };
