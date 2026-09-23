const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startApp, expectOkLogin } = require("./helpers");

test("regression: install -> launch -> save -> relaunch preserves game data", async () => {
  const ctx = await startApp();
  try {
    const alice = await ctx.login("alice");
    expectOkLogin(alice);

    let result = await ctx.request("/api/library/keen1/install", alice.cookie, { method: "POST" });
    assert.equal(result.response.status, 200);

    result = await ctx.request("/api/library/keen1/install", alice.cookie, { method: "POST" });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.alreadyInstalled, true);

    const firstLaunch = await ctx.request("/api/library/keen1/launch", alice.cookie, { method: "POST" });
    assert.equal(firstLaunch.response.status, 201);

    let rpc = await ctx.fsRpc(alice.cookie, firstLaunch.body.session.id, "open", {
      path: "GAMES\KEEN1\REGRESS.SAV",
      flags: "w+",
    });
    assert.equal(rpc.header.ok, true);
    const handle = rpc.header.handle;
    rpc = await ctx.fsRpc(
      alice.cookie,
      firstLaunch.body.session.id,
      "write",
      { handle, position: 0 },
      Buffer.from("score=8675309\nlevel=3\n")
    );
    assert.equal(rpc.header.ok, true);
    await ctx.fsRpc(alice.cookie, firstLaunch.body.session.id, "close", { handle });

    const secondLaunch = await ctx.request("/api/library/keen1/launch", alice.cookie, { method: "POST" });
    assert.equal(secondLaunch.response.status, 201);
    rpc = await ctx.fsRpc(alice.cookie, secondLaunch.body.session.id, "open", {
      path: "GAMES\KEEN1\REGRESS.SAV",
      flags: "r",
    });
    const readHandle = rpc.header.handle;
    const read = await ctx.fsRpc(alice.cookie, secondLaunch.body.session.id, "read", {
      handle: readHandle,
      position: 0,
      length: 128,
    });
    assert.equal(Buffer.from(read.payload).toString(), "score=8675309\nlevel=3\n");
    await ctx.fsRpc(alice.cookie, secondLaunch.body.session.id, "close", { handle: readHandle });
  } finally {
    await ctx.close();
  }
});

test("regression: DOS console and game launch see the same personal C drive", async () => {
  const ctx = await startApp();
  try {
    const bob = await ctx.login("bob");
    expectOkLogin(bob);
    await ctx.request("/api/library/doom/install", bob.cookie, { method: "POST" });

    const consoleLaunch = await ctx.request("/api/console/launch", bob.cookie, { method: "POST" });
    let rpc = await ctx.fsRpc(bob.cookie, consoleLaunch.body.session.id, "open", {
      path: "USER\FROMDOS.TXT",
      flags: "w+",
    });
    const handle = rpc.header.handle;
    await ctx.fsRpc(
      bob.cookie,
      consoleLaunch.body.session.id,
      "write",
      { handle, position: 0 },
      Buffer.from("same-drive")
    );
    await ctx.fsRpc(bob.cookie, consoleLaunch.body.session.id, "close", { handle });

    const gameLaunch = await ctx.request("/api/library/doom/launch", bob.cookie, { method: "POST" });
    rpc = await ctx.fsRpc(bob.cookie, gameLaunch.body.session.id, "open", {
      path: "USER\FROMDOS.TXT",
      flags: "r",
    });
    const gameHandle = rpc.header.handle;
    const read = await ctx.fsRpc(bob.cookie, gameLaunch.body.session.id, "read", {
      handle: gameHandle,
      position: 0,
      length: 32,
    });
    assert.equal(Buffer.from(read.payload).toString(), "same-drive");
  } finally {
    await ctx.close();
  }
});

test("regression: uninstall removes only the selected user's game and blocks relaunch", async () => {
  const ctx = await startApp();
  try {
    const alice = await ctx.login("alice");
    const bob = await ctx.login("bob");
    expectOkLogin(alice);
    expectOkLogin(bob);

    await ctx.request("/api/library/keen1/install", alice.cookie, { method: "POST" });
    await ctx.request("/api/library/keen1/install", bob.cookie, { method: "POST" });

    const removed = await ctx.request("/api/library/keen1", alice.cookie, { method: "DELETE" });
    assert.equal(removed.response.status, 200);
    assert.equal(removed.body.installed, false);

    const aliceLaunch = await ctx.request("/api/library/keen1/launch", alice.cookie, { method: "POST" });
    assert.equal(aliceLaunch.response.status, 409);

    const bobLaunch = await ctx.request("/api/library/keen1/launch", bob.cookie, { method: "POST" });
    assert.equal(bobLaunch.response.status, 201);

    const aliceDrive = ctx.app.platform.auth.userDriveRoot(alice.user.id);
    const bobDrive = ctx.app.platform.auth.userDriveRoot(bob.user.id);
    assert.equal(fs.existsSync(path.join(aliceDrive, "GAMES", "KEEN1")), false);
    assert.equal(fs.existsSync(path.join(bobDrive, "GAMES", "KEEN1")), true);
  } finally {
    await ctx.close();
  }
});

test("regression: logout invalidates the current session", async () => {
  const ctx = await startApp();
  try {
    const alice = await ctx.login("alice");
    expectOkLogin(alice);

    let result = await ctx.request("/api/catalog", alice.cookie);
    assert.equal(result.response.status, 200);

    result = await ctx.request("/api/auth/logout", alice.cookie, { method: "POST" });
    assert.equal(result.response.status, 200);
    assert.match(result.response.headers.get("set-cookie") || "", /Max-Age=0/i);

    result = await ctx.request("/api/catalog", alice.cookie);
    assert.equal(result.response.status, 401);
  } finally {
    await ctx.close();
  }
});

test("regression: expired launch sessions cannot be reused", async () => {
  const ctx = await startApp();
  try {
    const alice = await ctx.login("alice");
    expectOkLogin(alice);
    const launch = await ctx.request("/api/console/launch", alice.cookie, { method: "POST" });
    assert.equal(launch.response.status, 201);

    ctx.app.platform.db.prepare("UPDATE launch_sessions SET expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", launch.body.session.id);

    const result = await ctx.request("/api/launch/" + launch.body.session.id, alice.cookie);
    assert.equal(result.response.status, 404);
  } finally {
    await ctx.close();
  }
});

test("regression: catalog contract remains unique, visual, and launchable", async () => {
  const ctx = await startApp();
  try {
    const alice = await ctx.login("alice");
    expectOkLogin(alice);
    const catalog = await ctx.request("/api/catalog", alice.cookie);
    assert.equal(catalog.response.status, 200);
    assert.equal(catalog.body.games.length, 15);
    assert.equal(new Set(catalog.body.games.map(g => g.id)).size, 15);
    assert.ok(catalog.body.games.every(g => g.screenshot && g.distribution?.status === "verified-shareware"));
  } finally {
    await ctx.close();
  }
});
