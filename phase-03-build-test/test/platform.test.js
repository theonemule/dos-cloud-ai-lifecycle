const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAppServer } = require("../server");
const { encodePacket, decodePacket } = require("../src/protocol");

async function start() {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dos-cloud-platform-"));
  const app = createAppServer({ port: 0, stateRoot });
  const address = await app.listen();
  const base = "http://127.0.0.1:" + address.port;

  async function login(username) {
    const response = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: "doscloud" }),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie").split(";")[0];
    const body = await response.json();
    return { cookie, user: body.user };
  }

  async function request(url, cookie, options = {}) {
    const response = await fetch(base + url, {
      ...options,
      headers: { ...(options.headers || {}), cookie },
    });
    const body = await response.json().catch(() => ({}));
    return { response, body };
  }

  return { app, stateRoot, base, login, request };
}

test("catalog contains curated shareware packages and five demo users exist", async () => {
  const ctx = await start();
  try {
    const alice = await ctx.login("alice");
    const result = await ctx.request("/api/catalog", alice.cookie);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.games.length, 15);
    assert.ok(result.body.games.every(g => g.distribution.status === "verified-shareware"));
    for (const username of ["bob","carol","dave","erin"]) {
      const logged = await ctx.login(username);
      assert.equal(logged.user.username, username);
    }
  } finally {
    await ctx.app.close();
    fs.rmSync(ctx.stateRoot, { recursive: true, force: true });
  }
});

test("installed games and filesystem data are isolated by user", async () => {
  const ctx = await start();
  try {
    const alice = await ctx.login("alice");
    const bob = await ctx.login("bob");

    let result = await ctx.request("/api/library/keen1/install", alice.cookie, { method: "POST" });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.installed, true);

    result = await ctx.request("/api/library", alice.cookie);
    assert.equal(result.body.games.length, 1);
    assert.equal(result.body.games[0].id, "keen1");

    result = await ctx.request("/api/library", bob.cookie);
    assert.equal(result.body.games.length, 0);

    const aliceDrive = ctx.app.platform.auth.userDriveRoot(alice.user.id);
    const bobDrive = ctx.app.platform.auth.userDriveRoot(bob.user.id);
    assert.ok(fs.existsSync(path.join(aliceDrive, "GAMES", "KEEN1", "KEEN1WEB.BAT")));
    assert.ok(!fs.existsSync(path.join(bobDrive, "GAMES", "KEEN1")));

    result = await ctx.request("/api/library/keen1/launch", alice.cookie, { method: "POST" });
    assert.equal(result.response.status, 201);
    const launchId = result.body.session.id;

    result = await ctx.request("/api/launch/" + launchId, alice.cookie);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.launch.gameId, "keen1");
    assert.ok(result.body.launch.autoexec.some(x => x.includes("KEEN1WEB.BAT")));

    result = await ctx.request("/api/launch/" + launchId, bob.cookie);
    assert.equal(result.response.status, 404);
  } finally {
    await ctx.app.close();
    fs.rmSync(ctx.stateRoot, { recursive: true, force: true });
  }
});

test("multiple catalog packages install from metadata without game-specific server code", async () => {
  const ctx = await start();
  try {
    const user = await ctx.login("carol");
    for (const gameId of ["keen1", "doom", "wolf3d"]) {
      const result = await ctx.request("/api/library/" + gameId + "/install", user.cookie, { method: "POST" });
      assert.equal(result.response.status, 200);
      const launched = await ctx.request("/api/library/" + gameId + "/launch", user.cookie, { method: "POST" });
      assert.equal(launched.response.status, 201);
      const cfg = await ctx.request("/api/launch/" + launched.body.session.id, user.cookie);
      assert.equal(cfg.response.status, 200);
      assert.equal(cfg.body.launch.gameId, gameId);
    }
    const library = await ctx.request("/api/library", user.cookie);
    assert.equal(library.body.games.length, 3);
  } finally {
    await ctx.app.close();
    fs.rmSync(ctx.stateRoot, { recursive: true, force: true });
  }
});

test("DOS console launch targets the same private user drive", async () => {
  const ctx = await start();
  try {
    const user = await ctx.login("dave");
    const launch = await ctx.request("/api/console/launch", user.cookie, { method: "POST" });
    assert.equal(launch.response.status, 201);
    const cfg = await ctx.request("/api/launch/" + launch.body.session.id, user.cookie);
    assert.equal(cfg.body.launch.mode, "console");
    assert.equal(cfg.body.launch.autoexec[0], "mount c /remote/" + launch.body.session.id);
    assert.deepEqual(cfg.body.launch.autoexec.slice(1), ["c:", "cd \\"]);
  } finally {
    await ctx.app.close();
    fs.rmSync(ctx.stateRoot, { recursive: true, force: true });
  }
});

test("authenticated filesystem writes persist only in the owning user's C drive", async () => {
  const { encodePacket, decodePacket } = require("../src/protocol");
  const ctx = await start();
  try {
    const alice = await ctx.login("alice");
    const bob = await ctx.login("bob");
    await ctx.request("/api/library/keen1/install", alice.cookie, { method: "POST" });
    await ctx.request("/api/library/keen1/install", bob.cookie, { method: "POST" });

    const aliceLaunch = await ctx.request("/api/library/keen1/launch", alice.cookie, { method: "POST" });
    const bobLaunch = await ctx.request("/api/library/keen1/launch", bob.cookie, { method: "POST" });
    assert.equal(aliceLaunch.response.status, 201);
    assert.equal(bobLaunch.response.status, 201);

    let requestId = 1;
    async function rpc(cookie, launchId, session, op, args = {}, payload = new Uint8Array()) {
      const response = await fetch(ctx.base + "/api/fs?client=test&launch=" + encodeURIComponent(launchId) + "&session=" + encodeURIComponent(session), {
        method: "POST",
        headers: { cookie, "content-type": "application/octet-stream" },
        body: encodePacket({ id: requestId++, op, ...args }, payload),
      });
      assert.equal(response.status, 200);
      const decoded = decodePacket(Buffer.from(await response.arrayBuffer()));
      if (!decoded.header.ok) throw Object.assign(new Error(decoded.header.error), { code: decoded.header.code });
      return decoded;
    }

    let r = await rpc(alice.cookie, aliceLaunch.body.session.id, "alice-save", "open", { path: "C:\\GAMES\\KEEN1\\DEMO.SAV", flags: "w+" });
    const aliceHandle = r.header.handle;
    await rpc(alice.cookie, aliceLaunch.body.session.id, "alice-save", "write", { handle: aliceHandle, position: 0 }, Buffer.from("ALICE-HIGH-SCORE=4242"));
    await rpc(alice.cookie, aliceLaunch.body.session.id, "alice-save", "close", { handle: aliceHandle });

    r = await rpc(alice.cookie, aliceLaunch.body.session.id, "alice-save-2", "open", { path: "C:\\GAMES\\KEEN1\\DEMO.SAV", flags: "r" });
    const read = await rpc(alice.cookie, aliceLaunch.body.session.id, "alice-save-2", "read", { handle: r.header.handle, length: 64, position: 0 });
    assert.equal(Buffer.from(read.payload).toString(), "ALICE-HIGH-SCORE=4242");
    await rpc(alice.cookie, aliceLaunch.body.session.id, "alice-save-2", "close", { handle: r.header.handle });

    await assert.rejects(
      () => rpc(bob.cookie, bobLaunch.body.session.id, "bob-save", "stat", { path: "C:\\GAMES\\KEEN1\\DEMO.SAV" }),
      err => err.code === "ENOENT"
    );

    const aliceDrive = ctx.app.platform.auth.userDriveRoot(alice.user.id);
    const bobDrive = ctx.app.platform.auth.userDriveRoot(bob.user.id);
    assert.equal(fs.readFileSync(path.join(aliceDrive, "GAMES", "KEEN1", "DEMO.SAV"), "utf8"), "ALICE-HIGH-SCORE=4242");
    assert.ok(!fs.existsSync(path.join(bobDrive, "GAMES", "KEEN1", "DEMO.SAV")));
  } finally {
    await ctx.app.close();
    fs.rmSync(ctx.stateRoot, { recursive: true, force: true });
  }
});


test("filesystem RPC requires an owned launch session and stays inside that user's drive", async () => {
  const ctx = await start();
  try {
    const alice = await ctx.login("alice");
    const bob = await ctx.login("bob");

    let result = await ctx.request("/api/console/launch", alice.cookie, { method: "POST" });
    assert.equal(result.response.status, 201);
    const launchId = result.body.session.id;

    let requestId = 1;
    async function fsRpc(cookie, launch, op, args = {}, payload = new Uint8Array(0)) {
      const response = await fetch(
        ctx.base + "/api/fs?launch=" + encodeURIComponent(launch) + "&session=test-rpc",
        {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/octet-stream",
          },
          body: encodePacket({ id: requestId++, op, ...args }, payload),
        }
      );
      const decoded = decodePacket(Buffer.from(await response.arrayBuffer()));
      return { status: response.status, ...decoded };
    }

    let rpc = await fsRpc(alice.cookie, launchId, "create", { path: "USER\\ALICE.TXT" });
    assert.equal(rpc.header.ok, true);

    rpc = await fsRpc(alice.cookie, launchId, "open", { path: "USER\\ALICE.TXT", flags: "w+" });
    assert.equal(rpc.header.ok, true);
    const handle = rpc.header.handle;

    rpc = await fsRpc(alice.cookie, launchId, "write", { handle, position: 0 }, Buffer.from("alice-only"));
    assert.equal(rpc.header.ok, true);
    await fsRpc(alice.cookie, launchId, "close", { handle });

    const aliceFile = path.join(ctx.app.platform.auth.userDriveRoot(alice.user.id), "USER", "ALICE.TXT");
    const bobFile = path.join(ctx.app.platform.auth.userDriveRoot(bob.user.id), "USER", "ALICE.TXT");
    assert.equal(fs.readFileSync(aliceFile, "utf8"), "alice-only");
    assert.equal(fs.existsSync(bobFile), false);

    rpc = await fsRpc(bob.cookie, launchId, "stat", { path: "" });
    assert.notEqual(rpc.header.ok, true);

    rpc = await fsRpc(alice.cookie, "", "stat", { path: "" });
    assert.notEqual(rpc.header.ok, true);
  } finally {
    await ctx.app.close();
    fs.rmSync(ctx.stateRoot, { recursive: true, force: true });
  }
});

test("all catalog packages match their checksums and contain their declared launch command", async () => {
  const AdmZip = require("adm-zip");
  const { fileSha256 } = require("../src/platform/library");
  const manifestsRoot = path.join(__dirname, "..", "catalog", "manifests");
  const packagesRoot = path.join(__dirname, "..", "catalog", "packages");
  const names = fs.readdirSync(manifestsRoot).filter(name => name.endsWith(".json"));
  assert.equal(names.length, 15);
  for (const name of names) {
    const manifest = JSON.parse(fs.readFileSync(path.join(manifestsRoot, name), "utf8"));
    const packagePath = path.join(packagesRoot, manifest.package.file);
    assert.equal(fileSha256(packagePath), manifest.package.sha256, manifest.id + " checksum mismatch");
    const zip = new AdmZip(packagePath);
    const entries = new Set(zip.getEntries().map(entry => entry.entryName.replaceAll("\\\\", "/").toUpperCase()));
    assert.ok(entries.has(manifest.launch.command.toUpperCase()), manifest.id + " launch command not found in package");
  }
});

test("registration creates a sixth user with an independent empty library", async () => {
  const ctx = await start();
  try {
    const response = await fetch(ctx.base + "/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "frank", displayName: "Frank", password: "doscloud2" }),
    });
    assert.equal(response.status, 201);
    const cookie = response.headers.get("set-cookie").split(";")[0];
    const body = await response.json();
    assert.equal(body.user.username, "frank");
    const library = await ctx.request("/api/library", cookie);
    assert.equal(library.response.status, 200);
    assert.deepEqual(library.body.games, []);
    assert.ok(fs.existsSync(path.join(ctx.app.platform.auth.userDriveRoot(body.user.id), "GAMES")));
  } finally {
    await ctx.app.close();
    fs.rmSync(ctx.stateRoot, { recursive: true, force: true });
  }
});

test("protected catalog and filesystem APIs reject unauthenticated requests", async () => {
  const ctx = await start();
  try {
    let response = await fetch(ctx.base + "/api/catalog");
    assert.equal(response.status, 401);
    response = await fetch(ctx.base + "/api/fs?session=anonymous", { method: "POST", body: Buffer.alloc(0) });
    assert.equal(response.status, 401);
  } finally {
    await ctx.app.close();
    fs.rmSync(ctx.stateRoot, { recursive: true, force: true });
  }
});


test("every catalog package installs and has a valid launch target", async () => {
  const ctx = await start();
  try {
    const user = await ctx.login("erin");
    const catalog = await ctx.request("/api/catalog", user.cookie);
    assert.equal(catalog.response.status, 200);
    assert.equal(catalog.body.games.length, 15);

    const drive = ctx.app.platform.auth.userDriveRoot(user.user.id);
    for (const game of catalog.body.games) {
      const installed = await ctx.request("/api/library/" + game.id + "/install", user.cookie, { method: "POST" });
      assert.equal(installed.response.status, 200, "install failed for " + game.id);

      const manifest = ctx.app.platform.catalog.get(game.id);
      const command = path.join(drive, "GAMES", manifest.install.folder, manifest.launch.command);
      assert.equal(fs.existsSync(command), true, "launch target missing for " + game.id + ": " + command);
      assert.ok(manifest.presentation?.screenshot, "screenshot metadata missing for " + game.id);
      const screenshot = path.join(path.resolve(__dirname, ".."), "public", manifest.presentation.screenshot.replace(/^\//, ""));
      assert.equal(fs.existsSync(screenshot), true, "catalog screenshot missing for " + game.id);

      const launched = await ctx.request("/api/library/" + game.id + "/launch", user.cookie, { method: "POST" });
      assert.equal(launched.response.status, 201, "launch session failed for " + game.id);
      const config = await ctx.request("/api/launch/" + launched.body.session.id, user.cookie);
      assert.equal(config.response.status, 200);
      assert.equal(config.body.launch.gameId, game.id);
      assert.equal(config.body.launch.autoexec.at(-1), manifest.launch.command);
    }
  } finally {
    await ctx.app.close();
    fs.rmSync(ctx.stateRoot, { recursive: true, force: true });
  }
});
