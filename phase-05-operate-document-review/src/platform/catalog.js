const fs = require("node:fs");
const path = require("node:path");

async function createCatalogService({ db, manifestsRoot }) {
  const manifests = new Map();

  function validateManifest(m, filename) {
    const required = [
      ["id", m.id],
      ["title", m.title],
      ["version", m.version],
      ["package.file", m.package?.file],
      ["package.sha256", m.package?.sha256],
      ["install.folder", m.install?.folder],
      ["launch.command", m.launch?.command],
    ];
    for (const [name, value] of required) {
      if (!value) throw new Error(filename + ": missing " + name);
    }
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(m.id)) throw new Error(filename + ": invalid game id");
    if (!/^[A-Za-z0-9._-]+$/.test(m.install.folder)) throw new Error(filename + ": invalid install folder");
    if (m.distribution?.status !== "verified-shareware" && m.distribution?.status !== "verified-freeware") {
      throw new Error(filename + ": catalog package must be verified shareware/freeware");
    }
    return m;
  }

  async function reload() {
    manifests.clear();
    fs.mkdirSync(manifestsRoot, { recursive: true });
    for (const name of fs.readdirSync(manifestsRoot).filter(x => x.endsWith(".json")).sort()) {
      const full = path.join(manifestsRoot, name);
      const manifest = validateManifest(JSON.parse(fs.readFileSync(full, "utf8")), name);
      manifest._manifestPath = full;
      manifests.set(manifest.id, manifest);
      await db.run(
        `INSERT INTO games(id,title,subtitle,publisher,year,genre_json,manifest_path,active)
         VALUES (?,?,?,?,?,?,?,1)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title,
           subtitle=excluded.subtitle,
           publisher=excluded.publisher,
           year=excluded.year,
           genre_json=excluded.genre_json,
           manifest_path=excluded.manifest_path,
           active=1`,
        manifest.id,
        manifest.title,
        manifest.subtitle || "",
        manifest.publisher || "",
        Number(manifest.year) || null,
        JSON.stringify(manifest.genres || []),
        full
      );
    }
    return manifests.size;
  }

  function get(id) {
    const m = manifests.get(id);
    if (!m) throw Object.assign(new Error("game not found"), { statusCode: 404 });
    return m;
  }

  function publicGame(manifest, installedRow) {
    return {
      id: manifest.id,
      title: manifest.title,
      subtitle: manifest.subtitle || "",
      publisher: manifest.publisher || "",
      year: manifest.year || null,
      genres: manifest.genres || [],
      description: manifest.description || "",
      version: manifest.version,
      accent: manifest.presentation?.accent || "#415a77",
      glyph: manifest.presentation?.glyph || manifest.title.slice(0, 2).toUpperCase(),
      screenshot: manifest.presentation?.screenshot || null,
      featured: Boolean(manifest.presentation?.featured),
      capabilities: manifest.capabilities || { singlePlayer: true, ipx: false },
      distribution: manifest.distribution,
      installed: Boolean(installedRow),
      installedAt: installedRow?.installed_at || null,
      lastPlayedAt: installedRow?.last_played_at || null,
    };
  }

  async function listForUser(userId) {
    const installed = new Map();
    if (userId) {
      for (const row of await db.all("SELECT * FROM user_games WHERE user_id = ?", userId)) {
        installed.set(row.game_id, row);
      }
    }
    return [...manifests.values()].map(m => publicGame(m, installed.get(m.id)));
  }

  await reload();

  return { reload, get, listForUser, publicGame, count: () => manifests.size };
}

module.exports = { createCatalogService };
