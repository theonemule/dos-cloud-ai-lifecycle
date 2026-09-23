const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { WebSocketServer } = require("ws");
const { DriveStore } = require("./src/drive-store");
const { encodePacket, decodePacket } = require("./src/protocol");

const ROOT = __dirname;
const DATA_ROOT = path.join(ROOT, "data");
const PUBLIC_ROOT = path.join(ROOT, "public");
const JSDOS_ROOT = path.join(ROOT, "node_modules", "js-dos", "dist");

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".wasm": "application/wasm",
    ".json": "application/json; charset=utf-8",
    ".jsdos": "application/octet-stream",
    ".png": "image/png",
    ".woff": "font/woff"
  })[ext] || "application/octet-stream";
}

function safeStatic(root, rel) {
  const resolved = path.resolve(root, "." + rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function readRequestBody(req, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(Object.assign(new Error("request body too large"), { code: "EFBIG" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function createAppServer(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? 8080);
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  const driveMetrics = new Map();
  const httpFsSessions = new Map();

  function metricsFor(driveId) {
    if (!driveMetrics.has(driveId)) {
      driveMetrics.set(driveId, {
        requests: 0,
        bytesRead: 0,
        bytesWritten: 0,
        ops: {},
        recent: [],
        connections: 0,
        activeConnections: 0,
        clients: {},
      });
    }
    return driveMetrics.get(driveId);
  }

  function record(driveId, op, args, requestBytes, result, clientId = "ui") {
    const metrics = metricsFor(driveId);
    metrics.requests++;
    metrics.ops[op] = (metrics.ops[op] || 0) + 1;
    if (op === "write") metrics.bytesWritten += requestBytes;
    if (op === "read" && result?.payload) metrics.bytesRead += result.payload.length;

    const target = args.path ?? args.oldPath ?? "";
    metrics.recent.unshift({
      at: Date.now(),
      op,
      path: target,
      bytes: op === "write" ? requestBytes : (result?.payload?.length || 0),
      client: clientId,
    });
    metrics.recent = metrics.recent.slice(0, 24);
  }

  function corsHeaders() {
    return {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "cache-control": "no-store",
    };
  }

  function getHttpFsSession(driveId, clientId, sessionId) {
    const key = driveId + ":" + sessionId;
    let session = httpFsSessions.get(key);
    if (!session) {
      session = {
        driveId,
        clientId,
        drive: new DriveStore(path.join(DATA_ROOT, driveId)),
        handlePaths: new Map(),
        lastSeen: Date.now(),
      };
      httpFsSessions.set(key, session);
      const metrics = metricsFor(driveId);
      metrics.connections++;
      metrics.activeConnections++;
      metrics.clients[clientId] = (metrics.clients[clientId] || 0) + 1;
    }
    session.lastSeen = Date.now();
    return session;
  }

  const sessionCleanup = setInterval(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [key, session] of httpFsSessions) {
      if (session.lastSeen < cutoff) {
        httpFsSessions.delete(key);
        const metrics = metricsFor(session.driveId);
        metrics.activeConnections = Math.max(0, metrics.activeConnections - 1);
        session.drive.closeAll();
      }
    }
  }, 60 * 1000);
  sessionCleanup.unref();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (url.pathname === "/api/fs") {
      const headers = corsHeaders();

      if (req.method === "OPTIONS") {
        res.writeHead(204, headers);
        return res.end();
      }

      if (req.method !== "POST") {
        res.writeHead(405, { ...headers, "content-type": "text/plain; charset=utf-8" });
        return res.end("method not allowed");
      }

      const driveId = (url.searchParams.get("drive") || "demo").replace(/[^A-Za-z0-9_-]/g, "_");
      const clientId = (url.searchParams.get("client") || "emulator").replace(/[^A-Za-z0-9_-]/g, "_");
      const sessionId = (url.searchParams.get("session") || "default").replace(/[^A-Za-z0-9_.-]/g, "_");
      const session = getHttpFsSession(driveId, clientId, sessionId);

      (async () => {
        let request;
        try {
          const raw = await readRequestBody(req);
          request = decodePacket(raw);
          const { id, op, ...args } = request.header;
          const result = await session.drive.dispatch(op, args, request.payload);

          if (op === "open" && result?.handle != null) {
            session.handlePaths.set(Number(result.handle), args.path || "");
          }

          const recordArgs = (!args.path && args.handle != null && session.handlePaths.has(Number(args.handle)))
            ? { ...args, path: session.handlePaths.get(Number(args.handle)) }
            : args;

          record(driveId, op, recordArgs, request.payload?.length || 0, result, clientId);

          if (op === "close" && args.handle != null) {
            session.handlePaths.delete(Number(args.handle));
          }

          const header = result && result.header ? result.header : result || {};
          const payload = result && result.payload ? result.payload : new Uint8Array(0);
          const response = encodePacket({ id, ok: true, ...header }, payload);
          res.writeHead(200, { ...headers, "content-type": "application/octet-stream" });
          res.end(response);
        } catch (err) {
          const id = request?.header?.id ?? null;
          const response = encodePacket({
            id,
            ok: false,
            code: err.code || "EIO",
            error: err.message || String(err)
          });
          if (!res.headersSent) {
            res.writeHead(200, { ...headers, "content-type": "application/octet-stream" });
          }
          res.end(response);
        }
      })();

      return;
    }

    if (url.pathname === "/api/stats") {
      const driveId = (url.searchParams.get("drive") || "demo").replace(/[^A-Za-z0-9_-]/g, "_");
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      return res.end(JSON.stringify(metricsFor(driveId)));
    }

    let file;
    if (url.pathname.startsWith("/jsdos/")) {
      file = safeStatic(JSDOS_ROOT, url.pathname.slice("/jsdos".length));
    } else {
      const rel = url.pathname === "/" ? "/index.html" : url.pathname;
      file = safeStatic(PUBLIC_ROOT, rel);
    }

    if (!file) {
      res.writeHead(403);
      return res.end("forbidden");
    }

    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404);
        return res.end("not found");
      }
      res.writeHead(200, {
        "content-type": contentType(file),
        "cache-control": "no-store"
      });
      fs.createReadStream(file).pipe(res);
    });
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/ws/fs") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const driveId = (url.searchParams.get("drive") || "demo").replace(/[^A-Za-z0-9_-]/g, "_");
      const clientId = (url.searchParams.get("client") || "ui").replace(/[^A-Za-z0-9_-]/g, "_");
      const drive = new DriveStore(path.join(DATA_ROOT, driveId));
      const handlePaths = new Map();
      const metrics = metricsFor(driveId);
      metrics.connections++;
      metrics.activeConnections++;
      metrics.clients[clientId] = (metrics.clients[clientId] || 0) + 1;
      ws.on("message", async (raw) => {
        let request;
        try {
          request = decodePacket(raw);
          const { id, op, ...args } = request.header;
          const result = await drive.dispatch(op, args, request.payload);
          if (op === "open" && result?.handle != null) {
            handlePaths.set(Number(result.handle), args.path || "");
          }
          const recordArgs = (!args.path && args.handle != null && handlePaths.has(Number(args.handle)))
            ? { ...args, path: handlePaths.get(Number(args.handle)) }
            : args;
          record(driveId, op, recordArgs, request.payload?.length || 0, result, clientId);
          if (op === "close" && args.handle != null) {
            handlePaths.delete(Number(args.handle));
          }
          const header = result && result.header ? result.header : result || {};
          const payload = result && result.payload ? result.payload : new Uint8Array(0);
          ws.send(encodePacket({ id, ok: true, ...header }, payload));
        } catch (err) {
          const id = request?.header?.id ?? null;
          ws.send(encodePacket({
            id,
            ok: false,
            code: err.code || "EIO",
            error: err.message || String(err)
          }));
        }
      });

      ws.on("close", () => {
        metrics.activeConnections = Math.max(0, metrics.activeConnections - 1);
        drive.closeAll();
      });
      ws.on("error", () => drive.closeAll());
    });
  });

  return {
    server,
    wss,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "0.0.0.0", () => {
          server.off("error", reject);
          resolve(server.address());
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        clearInterval(sessionCleanup);
        for (const session of httpFsSessions.values()) {
          session.drive.closeAll();
        }
        httpFsSessions.clear();
        for (const client of wss.clients) client.terminate();
        wss.close(() => server.close(resolve));
      });
    }
  };
}

if (require.main === module) {
  const app = createAppServer();
  app.listen().then((addr) => {
    console.log(`DOS remote-drive spike listening on http://0.0.0.0:${addr.port}`);
  });
}

module.exports = { createAppServer };
