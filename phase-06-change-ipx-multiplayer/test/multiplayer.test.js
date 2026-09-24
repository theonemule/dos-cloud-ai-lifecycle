const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");
const { startApp, expectOkLogin } = require("./helpers");

async function install(ctx, login, gameId) {
  const result = await ctx.request("/api/library/" + gameId + "/install", login.cookie, {
    method: "POST",
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
}

function connectIpx(ctx, cookie, launchId) {
  const url = ctx.base.replace(/^http/, "ws") + "/ws/ipx?launch=" + encodeURIComponent(launchId);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { cookie, origin: ctx.base } });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("IPX WebSocket timeout"));
    }, 5000);
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (message.type === "welcome") {
        clearTimeout(timer);
        resolve({ ws, welcome: message });
      }
    });
    ws.once("error", err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function nextBinary(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("binary relay timeout"));
    }, 5000);
    const onMessage = (data, isBinary) => {
      if (!isBinary) return;
      cleanup();
      resolve(Buffer.from(data));
    };
    function cleanup() {
      clearTimeout(timer);
      ws.off("message", onMessage);
    }
    ws.on("message", onMessage);
  });
}

function targetFrame(peerId, payload) {
  const body = Buffer.from(payload);
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32BE(peerId, 0);
  body.copy(frame, 4);
  return frame;
}

async function createRoom(ctx, hostLogin, players = 2) {
  const response = await ctx.request("/api/multiplayer/host", hostLogin.cookie, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gameId: "doom", players }),
  });
  assert.equal(response.response.status, 201, JSON.stringify(response.body));
  return response.body;
}

async function joinRoom(ctx, login, code) {
  return ctx.request("/api/multiplayer/join", login.cookie, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

test("multiplayer: host creates a short room code and launch config switches to IPX", async () => {
  const ctx = await startApp();
  try {
    const alice = await ctx.login("alice");
    expectOkLogin(alice);
    await install(ctx, alice, "doom");

    const hosted = await createRoom(ctx, alice, 3);
    assert.match(hosted.room.code, /^[A-Z2-9]{6}$/);
    assert.equal(hosted.room.gameId, "doom");
    assert.equal(hosted.room.expectedPlayers, 3);

    const config = await ctx.request("/api/launch/" + hosted.session.id, alice.cookie);
    assert.equal(config.response.status, 200);
    assert.equal(config.body.launch.multiplayer.role, "host");
    assert.equal(config.body.launch.multiplayer.code, hosted.room.code);
    assert.equal(config.body.launch.multiplayer.transport, "websocket-ipx");
    assert.equal(config.body.launch.autoexec.at(-1), "IPXSETUP.EXE -nodes 3");
    assert.ok(config.body.launch.autoexec.includes("cd \\GAMES\\DOOM\\DOOMS"));
  } finally {
    await ctx.close();
  }
});

test("multiplayer: join code creates an independent client launch and enforces room capacity", async () => {
  const ctx = await startApp();
  try {
    const alice = await ctx.login("alice");
    const bob = await ctx.login("bob");
    const carol = await ctx.login("carol");
    expectOkLogin(alice);
    expectOkLogin(bob);
    expectOkLogin(carol);
    await install(ctx, alice, "doom");
    await install(ctx, bob, "doom");

    const hosted = await createRoom(ctx, alice, 2);
    const joined = await joinRoom(ctx, bob, hosted.room.code.toLowerCase());
    assert.equal(joined.response.status, 201, JSON.stringify(joined.body));
    assert.equal(joined.body.room.code, hosted.room.code);
    assert.notEqual(joined.body.session.id, hosted.session.id);

    const config = await ctx.request("/api/launch/" + joined.body.session.id, bob.cookie);
    assert.equal(config.body.launch.multiplayer.role, "client");
    assert.equal(config.body.launch.multiplayer.peerId, 2);

    const full = await joinRoom(ctx, carol, hosted.room.code);
    assert.equal(full.response.status, 409);
    assert.equal(full.body.code, "EROOMFULL");
  } finally {
    await ctx.close();
  }
});

test("multiplayer: the same account can join its own room through a second launch session", async () => {
  const ctx = await startApp();
  try {
    const alice = await ctx.login("alice");
    expectOkLogin(alice);
    await install(ctx, alice, "doom");

    const hosted = await createRoom(ctx, alice, 2);
    const joined = await joinRoom(ctx, alice, hosted.room.code);
    assert.equal(joined.response.status, 201, JSON.stringify(joined.body));
    assert.notEqual(joined.body.session.id, hosted.session.id);

    const config = await ctx.request("/api/launch/" + joined.body.session.id, alice.cookie);
    assert.equal(config.response.status, 200);
    assert.equal(config.body.launch.multiplayer.role, "client");
    assert.equal(config.body.launch.multiplayer.peerId, 2);
    assert.equal(config.body.launch.multiplayer.code, hosted.room.code);
  } finally {
    await ctx.close();
  }
});

test("multiplayer: WebSocket relay carries targeted binary IPX frames only inside the room", async () => {
  const ctx = await startApp();
  let hostSocket;
  let clientSocket;
  try {
    const alice = await ctx.login("alice");
    const bob = await ctx.login("bob");
    expectOkLogin(alice);
    expectOkLogin(bob);
    await install(ctx, alice, "doom");
    await install(ctx, bob, "doom");

    const hosted = await createRoom(ctx, alice, 2);
    const joined = await joinRoom(ctx, bob, hosted.room.code);
    assert.equal(joined.response.status, 201);

    const host = await connectIpx(ctx, alice.cookie, hosted.session.id);
    hostSocket = host.ws;
    assert.equal(host.welcome.peerId, 1);
    assert.equal(host.welcome.role, "host");

    const client = await connectIpx(ctx, bob.cookie, joined.body.session.id);
    clientSocket = client.ws;
    assert.equal(client.welcome.peerId, 2);
    assert.equal(client.welcome.hostPeerId, 1);
    assert.equal(client.welcome.hostOnline, true);

    let incoming = nextBinary(hostSocket);
    clientSocket.send(targetFrame(1, "client-to-host"));
    let frame = await incoming;
    assert.equal(frame.readUInt32BE(0), 2);
    assert.equal(frame.subarray(4).toString(), "client-to-host");

    incoming = nextBinary(clientSocket);
    hostSocket.send(targetFrame(2, "host-to-client"));
    frame = await incoming;
    assert.equal(frame.readUInt32BE(0), 1);
    assert.equal(frame.subarray(4).toString(), "host-to-client");
  } finally {
    if (hostSocket) hostSocket.terminate();
    if (clientSocket) clientSocket.terminate();
    await ctx.close();
  }
});

test("multiplayer: ordinary launch sessions cannot open the IPX relay", async () => {
  const ctx = await startApp();
  try {
    const alice = await ctx.login("alice");
    expectOkLogin(alice);
    await install(ctx, alice, "doom");
    const launch = await ctx.request("/api/library/doom/launch", alice.cookie, { method: "POST" });
    const wsUrl = ctx.base.replace(/^http/, "ws") + "/ws/ipx?launch=" + encodeURIComponent(launch.body.session.id);

    const status = await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { headers: { cookie: alice.cookie, origin: ctx.base } });
      ws.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode);
      });
      ws.once("open", () => {
        ws.terminate();
        reject(new Error("ordinary launch unexpectedly opened IPX relay"));
      });
      ws.once("error", () => {});
    });
    assert.equal(status, 403);
  } finally {
    await ctx.close();
  }
});

test("multiplayer: Duke Nukem 3D uses its original network setup with IPX already attached", async () => {
  const ctx = await startApp();
  try {
    const alice = await ctx.login("alice");
    expectOkLogin(alice);
    await install(ctx, alice, "duke3d");
    const hosted = await ctx.request("/api/multiplayer/host", alice.cookie, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId: "duke3d", players: 2 }),
    });
    assert.equal(hosted.response.status, 201, JSON.stringify(hosted.body));
    const config = await ctx.request("/api/launch/" + hosted.body.session.id, alice.cookie);
    assert.equal(config.response.status, 200);
    assert.equal(config.body.launch.autoexec.at(-1), "SETUP.EXE");
    assert.ok(config.body.launch.autoexec.includes("cd \\GAMES\\DUKE3D\\DUKE3D"));
    assert.match(config.body.launch.multiplayer.instructions, /Network Game/i);
  } finally {
    await ctx.close();
  }
});
