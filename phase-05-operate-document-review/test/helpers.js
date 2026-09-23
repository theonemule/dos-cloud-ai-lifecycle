const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAppServer } = require("../server");
const { encodePacket, decodePacket } = require("../src/protocol");

async function startApp(options = {}) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dos-cloud-phase4-"));
  const app = createAppServer({
    port: 0,
    stateRoot,
    seedDemoUsers: true,
    ...options,
  });
  const address = await app.listen();
  const base = "http://127.0.0.1:" + address.port;

  async function login(username = "alice", password = "doscloud") {
    const response = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      const cookie = response.headers.get("set-cookie")?.split(";")[0] || "";
      return { response, body, cookie, user: body.user };
    }
    return { response, body, cookie: "", user: null };
  }

  async function request(url, cookie = "", options = {}) {
    const headers = { ...(options.headers || {}) };
    if (cookie) headers.cookie = cookie;
    const response = await fetch(base + url, { ...options, headers });
    const type = response.headers.get("content-type") || "";
    const body = type.includes("application/json")
      ? await response.json().catch(() => ({}))
      : await response.text().catch(() => "");
    return { response, body };
  }

  let rpcId = 1;
  async function fsRpc(cookie, launchId, op, args = {}, payload = new Uint8Array(), headers = {}) {
    const response = await fetch(
      base + "/api/fs?launch=" + encodeURIComponent(launchId) + "&session=phase4-test",
      {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/octet-stream",
          ...headers,
        },
        body: encodePacket({ id: rpcId++, op, ...args }, payload),
      }
    );
    const decoded = decodePacket(Buffer.from(await response.arrayBuffer()));
    return { response, ...decoded };
  }

  async function close() {
    await app.close();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }

  return { app, stateRoot, base, login, request, fsRpc, close };
}

function expectOkLogin(result) {
  assert.equal(result.response.status, 200);
  assert.ok(result.cookie);
  assert.ok(result.user);
}

module.exports = { startApp, expectOkLogin };
