const crypto = require("node:crypto");
const { nowIso } = require("./database");

function randomSessionId() {
  return crypto.randomBytes(24).toString("base64url");
}

function createLaunchService({ db, catalog, library }) {
  async function create(user, { mode, gameId = null }) {
    if (mode === "game") {
      if (!gameId) throw Object.assign(new Error("game id required"), { statusCode: 400 });
      if (!await library.getInstalled(user.id, gameId)) {
        throw Object.assign(new Error("game is not installed for this user"), { statusCode: 409 });
      }
      catalog.get(gameId);
    }

    const id = randomSessionId();
    const created = new Date();
    const expires = new Date(created.getTime() + 2 * 60 * 60 * 1000);
    await db.run(
      `INSERT INTO launch_sessions(id,user_id,game_id,mode,created_at,expires_at)
       VALUES (?,?,?,?,?,?)`,
      id, user.id, gameId, mode, created.toISOString(), expires.toISOString()
    );

    if (gameId) await library.markPlayed(user.id, gameId);
    return { id, mode, gameId, expiresAt: expires.toISOString() };
  }

  async function getOwned(user, id) {
    const row = await db.get(
      `SELECT * FROM launch_sessions
       WHERE id = ? AND user_id = ? AND expires_at > ?`,
      id, user.id, nowIso()
    );
    if (!row) throw Object.assign(new Error("launch session not found or expired"), { statusCode: 404 });
    return row;
  }

  async function getConfig(user, id) {
    const row = await getOwned(user, id);
    if (row.mode === "console") {
      return {
        id: row.id,
        mode: "console",
        title: "DOS Console",
        autoexec: ["mount c /remote/" + row.id, "c:", "cd \\"],
        dosbox: { machine: "svga_s3", memoryMb: 16, cycles: "auto" },
      };
    }

    const manifest = catalog.get(row.game_id);
    const folder = manifest.install.folder;
    return {
      id: row.id,
      mode: "game",
      gameId: manifest.id,
      title: manifest.title,
      subtitle: manifest.subtitle || "",
      autoexec: [
        "mount c /remote/" + row.id,
        "c:",
        "cd \\GAMES\\" + folder,
        manifest.launch.command + (manifest.launch.arguments?.length ? " " + manifest.launch.arguments.join(" ") : ""),
      ],
      dosbox: manifest.dosbox || { machine: "svga_s3", memoryMb: 16, cycles: "auto" },
      controls: manifest.controls || [],
      accent: manifest.presentation?.accent || "#415a77",
    };
  }

  return { create, getOwned, getConfig };
}

module.exports = { createLaunchService };
