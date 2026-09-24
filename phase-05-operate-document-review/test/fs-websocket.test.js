const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");
const { startApp, expectOkLogin } = require("./helpers");
const { encodePacket, decodePacket } = require("../src/protocol");

function connectFsSocket(ctx, cookie, launchId, session = "ws-test") {
  const wsUrl = ctx.base.replace(/^http/, "ws") +
    "/ws/fs?launch=" + encodeURIComponent(launchId) +
    "&session=" + encodeURIComponent(session);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: {
        cookie,
        origin: ctx.base,
      },
    });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("WebSocket connection timeout"));
    }, 5000);

    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function createRpc(ws) {
  let id = 1;
  return async function rpc(op, args = {}, payload = new Uint8Array()) {
    const requestId = id++;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket RPC timeout")), 5000);
      ws.once("message", data => {
        clearTimeout(timer);
        const decoded = decodePacket(data);
        try {
          assert.equal(decoded.header.id, requestId);
          if (!decoded.header.ok) {
            throw Object.assign(new Error(decoded.header.error), { code: decoded.header.code });
          }
          resolve(decoded);
        } catch (err) {
          reject(err);
        }
      });
    });
    ws.send(encodePacket({ id: requestId, op, ...args }, payload));
    return response;
  };
}

test("filesystem WebSocket authenticates once and supports handle-based read/write/flush", async () => {
  const ctx = await startApp();
  let ws;
  try {
    const login = await ctx.login();
    expectOkLogin(login);

    const launch = await ctx.request("/api/console/launch", login.cookie, { method: "POST" });
    assert.equal(launch.response.status, 201);
    const launchId = launch.body.session.id;

    ws = await connectFsSocket(ctx, login.cookie, launchId);
    const rpc = createRpc(ws);

    let result = await rpc("open", { path: "USER/WS-CACHE.TXT", flags: "w+" });
    const handle = result.header.handle;
    assert.ok(Number.isInteger(handle));

    result = await rpc(
      "write",
      { handle, position: 0 },
      Buffer.from("websocket-filesystem")
    );
    assert.equal(result.header.bytesWritten, 20);

    await rpc("flush", { handle });

    result = await rpc("read", { handle, position: 0, length: 128 });
    assert.equal(Buffer.from(result.payload).toString(), "websocket-filesystem");

    await rpc("close", { handle });

    result = await rpc("list", { path: "USER" });
    assert.ok(result.header.entries.some(entry => entry.name === "WS-CACHE.TXT"));

    const stats = await ctx.request("/api/stats", login.cookie);
    assert.equal(stats.response.status, 200);
    assert.ok(stats.body.transports.websocket >= 6);
    assert.equal(stats.body.transports.http, 0);
  } finally {
    if (ws) ws.terminate();
    await ctx.close();
  }
});

test("filesystem WebSocket rejects an unauthenticated upgrade", async () => {
  const ctx = await startApp();
  try {
    const login = await ctx.login();
    expectOkLogin(login);
    const launch = await ctx.request("/api/console/launch", login.cookie, { method: "POST" });
    const launchId = launch.body.session.id;
    const wsUrl = ctx.base.replace(/^http/, "ws") +
      "/ws/fs?launch=" + encodeURIComponent(launchId) +
      "&session=unauth";

    const statusCode = await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { headers: { origin: ctx.base } });
      ws.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode);
      });
      ws.once("open", () => {
        ws.terminate();
        reject(new Error("unauthenticated WebSocket unexpectedly opened"));
      });
      ws.once("error", () => {});
    });

    assert.equal(statusCode, 401);
  } finally {
    await ctx.close();
  }
});

test("runtime responses opt into cross-origin isolation for SharedArrayBuffer", async () => {
  const ctx = await startApp();
  try {
    const response = await fetch(ctx.base + "/runtime.html");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(response.headers.get("cross-origin-embedder-policy"), "require-corp");
  } finally {
    await ctx.close();
  }
});
