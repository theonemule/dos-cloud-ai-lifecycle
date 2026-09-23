const test = require("node:test");
const assert = require("node:assert/strict");
const { encodePacket, decodePacket } = require("../src/protocol");
const { startApp, expectOkLogin } = require("./helpers");

test("security: baseline browser security headers are present", async () => {
  const ctx = await startApp();
  try {
    const response = await fetch(ctx.base + "/");
    assert.equal(response.status, 200);
    const csp = response.headers.get("content-security-policy") || "";
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /'unsafe-eval'/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.match(response.headers.get("permissions-policy") || "", /camera=()/);
    assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
  } finally {
    await ctx.close();
  }
});



test("security: unsafe-eval is scoped only to the emulator runtime document", async () => {
  const ctx = await startApp();
  try {
    const runtime = await fetch(ctx.base + "/runtime.html");
    const runtimeCsp = runtime.headers.get("content-security-policy") || "";
    assert.match(runtimeCsp, /script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'/);

    const app = await fetch(ctx.base + "/");
    assert.doesNotMatch(app.headers.get("content-security-policy") || "", /'unsafe-eval'/);
  } finally {
    await ctx.close();
  }
});

test("security: session cookie is HttpOnly/SameSite and supports Secure for TLS deployments", async () => {
  const plain = await startApp();
  try {
    const login = await plain.login("alice");
    expectOkLogin(login);
    const cookie = login.response.headers.get("set-cookie") || "";
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.doesNotMatch(cookie, /;\s*Secure/i);
  } finally {
    await plain.close();
  }

  const tls = await startApp({ secureCookies: true });
  try {
    const login = await tls.login("alice");
    expectOkLogin(login);
    assert.match(login.response.headers.get("set-cookie") || "", /;\s*Secure/i);
  } finally {
    await tls.close();
  }
});

test("security: cross-site state-changing requests are rejected", async () => {
  const ctx = await startApp();
  try {
    const alice = await ctx.login("alice");
    expectOkLogin(alice);

    const response = await fetch(ctx.base + "/api/library/keen1/install", {
      method: "POST",
      headers: {
        cookie: alice.cookie,
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
    });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.ok(["ECROSSSITE", "EORIGIN"].includes(body.code));

    const library = await ctx.request("/api/library", alice.cookie);
    assert.equal(library.body.games.length, 0);
  } finally {
    await ctx.close();
  }
});

test("security: filesystem CORS allows same-origin and refuses arbitrary origins", async () => {
  const ctx = await startApp();
  try {
    let response = await fetch(ctx.base + "/api/fs", {
      method: "OPTIONS",
      headers: {
        origin: ctx.base,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), ctx.base);
    assert.equal(response.headers.get("access-control-allow-credentials"), "true");

    response = await fetch(ctx.base + "/api/fs", {
      method: "OPTIONS",
      headers: {
        origin: "https://attacker.example",
        "access-control-request-method": "POST",
      },
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  } finally {
    await ctx.close();
  }
});

test("security: launch-session IDOR and cross-user filesystem access are denied", async () => {
  const ctx = await startApp();
  try {
    const alice = await ctx.login("alice");
    const bob = await ctx.login("bob");
    expectOkLogin(alice);
    expectOkLogin(bob);

    const launch = await ctx.request("/api/console/launch", alice.cookie, { method: "POST" });
    const id = launch.body.session.id;

    let response = await ctx.request("/api/launch/" + id, bob.cookie);
    assert.equal(response.response.status, 404);

    const rpc = await ctx.fsRpc(bob.cookie, id, "stat", { path: "" });
    assert.equal(rpc.header.ok, false);
  } finally {
    await ctx.close();
  }
});

test("security: filesystem path traversal and malformed packets fail closed without leaking host paths", async () => {
  const ctx = await startApp();
  try {
    const alice = await ctx.login("alice");
    expectOkLogin(alice);
    const launch = await ctx.request("/api/console/launch", alice.cookie, { method: "POST" });
    const id = launch.body.session.id;

    let rpc = await ctx.fsRpc(alice.cookie, id, "stat", { path: "..\..\server.js" });
    assert.equal(rpc.header.ok, false);
    assert.equal(rpc.header.error, "filesystem operation failed");
    assert.doesNotMatch(JSON.stringify(rpc.header), /var\/lib|sandbox-mcp|server\.js/i);

    const malformed = Buffer.from([0, 1, 0, 1, 0x7b, 0x7d]);
    const response = await fetch(ctx.base + "/api/fs?launch=" + encodeURIComponent(id) + "&session=malformed", {
      method: "POST",
      headers: {
        cookie: alice.cookie,
        "content-type": "application/octet-stream",
      },
      body: malformed,
    });
    assert.equal(response.status, 200);
    rpc = decodePacket(Buffer.from(await response.arrayBuffer()));
    assert.equal(rpc.header.ok, false);
    assert.equal(rpc.header.error, "filesystem operation failed");
  } finally {
    await ctx.close();
  }
});

test("security: authentication attempts are rate limited", async () => {
  const ctx = await startApp({
    security: { loginMax: 3, loginWindowMs: 60_000 },
  });
  try {
    for (let i = 0; i < 3; i++) {
      const result = await ctx.login("alice", "wrong-password");
      assert.equal(result.response.status, 401);
    }
    const limited = await ctx.login("alice", "wrong-password");
    assert.equal(limited.response.status, 429);
    assert.equal(limited.body.code, "ERATELIMIT");
    assert.ok(Number(limited.response.headers.get("retry-after")) >= 1);
  } finally {
    await ctx.close();
  }
});

test("security: oversized JSON bodies are rejected before authentication logic", async () => {
  const ctx = await startApp();
  try {
    const response = await fetch(ctx.base + "/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "oversized",
        displayName: "x".repeat(70 * 1024),
        password: "validpass123",
      }),
    });
    assert.equal(response.status, 413);
    const body = await response.json();
    assert.equal(body.code, "EFBIG");
  } finally {
    await ctx.close();
  }
});

test("security: account input policy rejects weak passwords and control-character display names", async () => {
  const ctx = await startApp({ seedDemoUsers: false });
  try {
    let response = await fetch(ctx.base + "/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "weakuser", displayName: "Weak", password: "short" }),
    });
    assert.equal(response.status, 400);

    response = await fetch(ctx.base + "/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "badname", displayName: "Bad\nName", password: "longenough" }),
    });
    assert.equal(response.status, 400);
  } finally {
    await ctx.close();
  }
});

test("security: production-style startup does not seed demo users by default", async () => {
  const ctx = await startApp({ seedDemoUsers: false });
  try {
    const result = await ctx.login("alice");
    assert.equal(result.response.status, 401);
  } finally {
    await ctx.close();
  }
});
