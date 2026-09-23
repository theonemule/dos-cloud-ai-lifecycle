const test = require("node:test");
const assert = require("node:assert/strict");
const { WebSocket } = require("ws");
const { createAppServer } = require("../server");
const { encodePacket, decodePacket } = require("../src/protocol");

class TestClient {
  constructor(url) {
    this.url = url;
    this.id = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    this.ws.on("message", (raw) => {
      const { header, payload } = decodePacket(raw);
      const p = this.pending.get(header.id);
      if (!p) return;
      this.pending.delete(header.id);
      if (header.ok) p.resolve({ header, payload });
      else p.reject(Object.assign(new Error(header.error), { code: header.code }));
    });
  }

  request(op, args = {}, payload = new Uint8Array(0)) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(encodePacket({ id, op, ...args }, payload));
    });
  }

  close() {
    return new Promise((resolve) => {
      this.ws.once("close", resolve);
      this.ws.close();
    });
  }
}

test("remote file share semantics persist across WebSocket sessions", async () => {
  const driveId = `test-${process.pid}-${Date.now()}`;
  const app = createAppServer({ port: 0 });
  const address = await app.listen();
  const url = `ws://127.0.0.1:${address.port}/ws/fs?drive=${driveId}`;

  try {
    const c1 = new TestClient(url);
    await c1.connect();

    await c1.request("mkdir", { path: "C:\\SAVE" });
    const opened = await c1.request("open", { path: "C:\\SAVE\\GAME.DAT", flags: "w+" });
    const handle = opened.header.handle;
    const payload = Buffer.from("HELLO DOS");

    let r = await c1.request("write", { handle }, payload);
    assert.equal(r.header.bytesWritten, payload.length);
    assert.equal(r.header.position, 9);

    r = await c1.request("seek", { handle, offset: 0, whence: 0 });
    assert.equal(r.header.position, 0);

    r = await c1.request("read", { handle, length: 5 });
    assert.equal(Buffer.from(r.payload).toString(), "HELLO");
    assert.equal(r.header.position, 5);

    r = await c1.request("seek", { handle, offset: 1, whence: 1 });
    assert.equal(r.header.position, 6);

    r = await c1.request("read", { handle, length: 3 });
    assert.equal(Buffer.from(r.payload).toString(), "DOS");

    await c1.request("close", { handle });
    await c1.close();

    const c2 = new TestClient(url);
    await c2.connect();
    const reopened = await c2.request("open", { path: "C:\\SAVE\\GAME.DAT", flags: "r" });
    r = await c2.request("read", { handle: reopened.header.handle, length: 64 });
    assert.equal(Buffer.from(r.payload).toString(), "HELLO DOS");
    await c2.request("close", { handle: reopened.header.handle });

    r = await c2.request("stat", { path: "C:\\SAVE\\GAME.DAT" });
    assert.equal(r.header.size, 9);
    assert.equal(r.header.file, true);

    r = await c2.request("list", { path: "C:\\SAVE" });
    assert.deepEqual(r.header.entries.map((x) => x.name), ["GAME.DAT"]);

    await c2.request("rename", {
      oldPath: "C:\\SAVE\\GAME.DAT",
      newPath: "C:\\SAVE\\RENAMED.DAT"
    });
    r = await c2.request("list", { path: "C:\\SAVE" });
    assert.deepEqual(r.header.entries.map((x) => x.name), ["RENAMED.DAT"]);

    await c2.request("unlink", { path: "C:\\SAVE\\RENAMED.DAT" });
    await c2.request("rmdir", { path: "C:\\SAVE" });
    await c2.close();
  } finally {
    await app.close();
  }
});

test("drive rejects traversal", async () => {
  const app = createAppServer({ port: 0 });
  const address = await app.listen();
  const c = new TestClient(`ws://127.0.0.1:${address.port}/ws/fs?drive=traversal-${process.pid}`);
  try {
    await c.connect();
    await assert.rejects(
      () => c.request("stat", { path: "C:\\..\\..\\etc\\passwd" }),
      (err) => err.code === "EINVAL" || err.code === "EACCES"
    );
    await c.close();
  } finally {
    await app.close();
  }
});

test("numeric POSIX-style flags and explicit positions work for emulator filesystem calls", async () => {
  const app = createAppServer({ port: 0 });
  const address = await app.listen();
  const c = new TestClient("ws://127.0.0.1:" + address.port + "/ws/fs?drive=numeric-" + process.pid);

  try {
    await c.connect();
    await c.request("create", { path: "C:\\EMU.DAT" });

    const opened = await c.request("open", {
      path: "C:\\EMU.DAT",
      flags: 2,
    });
    const handle = opened.header.handle;

    await c.request("write", { handle, position: 4 }, Buffer.from("DOS"));
    let r = await c.request("read", { handle, length: 7, position: 0 });
    assert.equal(Buffer.from(r.payload).toString("hex"), "00000000444f53");

    await c.request("close", { handle });
    await c.request("truncate", { path: "C:\\EMU.DAT", size: 5 });

    r = await c.request("stat", { path: "C:\\EMU.DAT" });
    assert.equal(r.header.size, 5);

    await c.request("unlink", { path: "C:\\EMU.DAT" });
    await c.close();
  } finally {
    await app.close();
  }
});

test("DOS paths resolve case-insensitively on a Linux backend", async () => {
  const app = createAppServer({ port: 0 });
  const address = await app.listen();
  const drive = "case-" + process.pid + "-" + Date.now();
  const c = new TestClient("ws://127.0.0.1:" + address.port + "/ws/fs?drive=" + drive);

  try {
    await c.connect();
    await c.request("mkdir", { path: "C:\\Games" });
    await c.request("create", { path: "C:\\Games\\SAVE.DAT" });

    let opened = await c.request("open", { path: "c:\\games\\save.dat", flags: 2 });
    await c.request("write", { handle: opened.header.handle, position: 0 }, Buffer.from("casefold"));
    await c.request("close", { handle: opened.header.handle });

    opened = await c.request("open", { path: "C:\\GAMES\\Save.Dat", flags: 0 });
    const r = await c.request("read", { handle: opened.header.handle, length: 32, position: 0 });
    assert.equal(Buffer.from(r.payload).toString(), "casefold");
    await c.request("close", { handle: opened.header.handle });

    await c.request("unlink", { path: "c:\\games\\SAVE.dat" });
    await c.request("rmdir", { path: "C:\\GAMES" });
    await c.close();
  } finally {
    await app.close();
  }
});

test("HTTP filesystem RPC preserves file handles across requests", async () => {
  const app = createAppServer({ port: 0 });
  const address = await app.listen();
  const endpoint = "http://127.0.0.1:" + address.port + "/api/fs?drive=http-" + process.pid + "&client=test&session=abc";
  let id = 1;

  async function rpc(op, args = {}, payload = new Uint8Array(0)) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: encodePacket({ id: id++, op, ...args }, payload),
    });
    assert.equal(response.status, 200);
    const decoded = decodePacket(Buffer.from(await response.arrayBuffer()));
    if (!decoded.header.ok) {
      throw Object.assign(new Error(decoded.header.error), { code: decoded.header.code });
    }
    return decoded;
  }

  try {
    let r = await rpc("open", { path: "C:\\HTTP.DAT", flags: "w+" });
    const handle = r.header.handle;

    await rpc("write", { handle, position: 0 }, Buffer.from("plain-http"));
    r = await rpc("read", { handle, length: 32, position: 0 });
    assert.equal(Buffer.from(r.payload).toString(), "plain-http");
    await rpc("close", { handle });

    r = await rpc("stat", { path: "c:\\http.dat" });
    assert.equal(r.header.size, 10);
    await rpc("unlink", { path: "C:\\HTTP.DAT" });

    const options = await fetch(endpoint, { method: "OPTIONS" });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get("access-control-allow-origin"), "*");
  } finally {
    await app.close();
  }
});
