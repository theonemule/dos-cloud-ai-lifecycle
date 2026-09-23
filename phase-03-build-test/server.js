const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const { DriveStore } = require("./src/drive-store");
const { encodePacket, decodePacket } = require("./src/protocol");
const { openDatabase } = require("./src/platform/database");
const { createAuthService } = require("./src/platform/auth");
const { createCatalogService } = require("./src/platform/catalog");
const { createLibraryService } = require("./src/platform/library");
const { createLaunchService } = require("./src/platform/launch");
const { json, text, readBody, readJson, handleError } = require("./src/platform/http-utils");

const ROOT = __dirname;
const PUBLIC_ROOT = path.join(ROOT, "public");
const JSDOS_ROOT = path.join(ROOT, "node_modules", "js-dos", "dist");
const MANIFESTS_ROOT = path.join(ROOT, "catalog", "manifests");
const PACKAGES_ROOT = path.join(ROOT, "catalog", "packages");

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
    ".svg": "image/svg+xml",
    ".woff": "font/woff",
  })[ext] || "application/octet-stream";
}

function safeStatic(root, rel) {
  const resolved = path.resolve(root, "." + rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function createAppServer(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? 8080);
  const stateRoot = path.resolve(options.stateRoot || ROOT);
  const dbPath = path.resolve(options.dbPath || path.join(stateRoot, "var", "doscloud.db"));
  const usersRoot = path.resolve(options.usersRoot || path.join(stateRoot, "user-data", "users"));

  const db = openDatabase(dbPath);
  const auth = createAuthService({ db, usersRoot });
  const catalog = createCatalogService({ db, manifestsRoot: MANIFESTS_ROOT });
  const library = createLibraryService({ db, catalog, packagesRoot: PACKAGES_ROOT, auth });
  const launch = createLaunchService({ db, catalog, library });

  if (options.seedDemoUsers !== false) auth.seedDemoUsers();

  const metricsByUser = new Map();
  const fsSessions = new Map();

  function metricsFor(userId) {
    if (!metricsByUser.has(userId)) {
      metricsByUser.set(userId, {
        requests: 0,
        bytesRead: 0,
        bytesWritten: 0,
        ops: {},
        recent: [],
      });
    }
    return metricsByUser.get(userId);
  }

  function recordFs(userId, op, args, requestBytes, result) {
    const metrics = metricsFor(userId);
    metrics.requests++;
    metrics.ops[op] = (metrics.ops[op] || 0) + 1;
    if (op === "write") metrics.bytesWritten += requestBytes;
    if (op === "read" && result?.payload) metrics.bytesRead += result.payload.length;
    metrics.recent.unshift({
      at: Date.now(),
      op,
      path: args.path || args.oldPath || "",
      bytes: op === "write" ? requestBytes : (result?.payload?.length || 0),
    });
    metrics.recent = metrics.recent.slice(0, 30);
  }

  function getFsSession(user, launchId, transportSession) {
    const safeSession = String(transportSession || "default").replace(/[^A-Za-z0-9_.-]/g, "_");
    const key = user.id + ":" + launchId + ":" + safeSession;
    let session = fsSessions.get(key);
    if (!session) {
      session = {
        userId: user.id,
        drive: new DriveStore(auth.userDriveRoot(user.id)),
        handlePaths: new Map(),
        lastSeen: Date.now(),
      };
      fsSessions.set(key, session);
    }
    session.lastSeen = Date.now();
    return session;
  }

  const cleanup = setInterval(() => {
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const [key, session] of fsSessions) {
      if (session.lastSeen < cutoff) {
        fsSessions.delete(key);
        session.drive.closeAll();
      }
    }
    db.prepare("DELETE FROM launch_sessions WHERE expires_at <= ?").run(new Date().toISOString());
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date().toISOString());
  }, 60 * 1000);
  cleanup.unref();

  async function handleApi(req, res, url) {
    if (url.pathname === "/api/auth/me" && req.method === "GET") {
      return json(res, 200, { user: auth.publicUser(auth.getUserFromRequest(req)) });
    }

    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      const body = await readJson(req);
      const result = auth.login(body.username, body.password);
      return json(res, 200, { user: auth.publicUser(result.user) }, {
        "set-cookie": auth.sessionCookie(result.token),
      });
    }

    if (url.pathname === "/api/auth/register" && req.method === "POST") {
      const body = await readJson(req);
      const user = auth.createUser(body);
      const token = auth.login(body.username, body.password).token;
      return json(res, 201, { user: auth.publicUser(user) }, {
        "set-cookie": auth.sessionCookie(token),
      });
    }

    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      auth.logout(req);
      return json(res, 200, { ok: true }, { "set-cookie": auth.clearSessionCookie() });
    }

    if (url.pathname === "/api/catalog" && req.method === "GET") {
      const user = auth.requireUser(req);
      return json(res, 200, { games: catalog.listForUser(user.id) });
    }

    if (url.pathname === "/api/library" && req.method === "GET") {
      const user = auth.requireUser(req);
      return json(res, 200, { games: library.list(user.id) });
    }

    let match = url.pathname.match(/^\/api\/library\/([a-z0-9-]+)\/install$/);
    if (match && req.method === "POST") {
      const user = auth.requireUser(req);
      return json(res, 200, library.install(user, match[1]));
    }

    match = url.pathname.match(/^\/api\/library\/([a-z0-9-]+)$/);
    if (match && req.method === "DELETE") {
      const user = auth.requireUser(req);
      return json(res, 200, library.uninstall(user, match[1]));
    }

    match = url.pathname.match(/^\/api\/library\/([a-z0-9-]+)\/launch$/);
    if (match && req.method === "POST") {
      const user = auth.requireUser(req);
      return json(res, 201, { session: launch.create(user, { mode: "game", gameId: match[1] }) });
    }

    if (url.pathname === "/api/console/launch" && req.method === "POST") {
      const user = auth.requireUser(req);
      return json(res, 201, { session: launch.create(user, { mode: "console" }) });
    }

    match = url.pathname.match(/^\/api\/launch\/([A-Za-z0-9_-]+)$/);
    if (match && req.method === "GET") {
      const user = auth.requireUser(req);
      return json(res, 200, { launch: launch.getConfig(user, match[1]) });
    }

    if (url.pathname === "/api/stats" && req.method === "GET") {
      const user = auth.requireUser(req);
      return json(res, 200, metricsFor(user.id));
    }

    if (url.pathname === "/api/fs") {
      const origin = req.headers.origin;
      const cors = origin ? {
        "access-control-allow-origin": origin,
        "access-control-allow-credentials": "true",
        "vary": "Origin",
      } : {};

      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          ...cors,
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type",
          "cache-control": "no-store",
        });
        return res.end();
      }

      if (req.method !== "POST") return text(res, 405, "method not allowed", cors);

      let request;
      try {
        const user = auth.requireUser(req);
        const launchId = String(url.searchParams.get("launch") || "");
        if (!launchId) throw Object.assign(new Error("launch session required"), { statusCode: 403, code: "EACCES" });
        launch.getOwned(user, launchId);
        const raw = await readBody(req);
        request = decodePacket(raw);
        const { id, op, ...args } = request.header;
        const session = getFsSession(user, launchId, url.searchParams.get("session"));
        const result = await session.drive.dispatch(op, args, request.payload);

        if (op === "open" && result?.handle != null) {
          session.handlePaths.set(Number(result.handle), args.path || "");
        }
        const recordArgs = (!args.path && args.handle != null && session.handlePaths.has(Number(args.handle)))
          ? { ...args, path: session.handlePaths.get(Number(args.handle)) }
          : args;
        recordFs(user.id, op, recordArgs, request.payload?.length || 0, result);
        if (op === "close" && args.handle != null) session.handlePaths.delete(Number(args.handle));

        const header = result && result.header ? result.header : result || {};
        const payload = result && result.payload ? result.payload : new Uint8Array(0);
        const response = encodePacket({ id, ok: true, ...header }, payload);
        res.writeHead(200, { ...cors, "content-type": "application/octet-stream", "cache-control": "no-store" });
        return res.end(response);
      } catch (err) {
        const id = request?.header?.id ?? null;
        const response = encodePacket({
          id,
          ok: false,
          code: err.code || (err.statusCode === 401 ? "EACCES" : "EIO"),
          error: err.message || String(err),
        });
        res.writeHead(err.statusCode === 401 ? 401 : 200, {
          ...cors,
          "content-type": "application/octet-stream",
          "cache-control": "no-store",
        });
        return res.end(response);
      }
    }

    return false;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname === "/health") {
        return json(res, 200, {
          ok: true,
          phase: 3,
          catalogGames: catalog.count(),
        });
      }

      if (url.pathname.startsWith("/api/")) {
        const handled = await handleApi(req, res, url);
        if (handled !== false) return;
        return json(res, 404, { error: "API route not found" });
      }

      let file;
      if (url.pathname.startsWith("/jsdos/")) {
        file = safeStatic(JSDOS_ROOT, url.pathname.slice("/jsdos".length));
      } else {
        const rel = url.pathname === "/" ? "/index.html" : url.pathname;
        file = safeStatic(PUBLIC_ROOT, rel);
      }

      if (!file) return text(res, 403, "forbidden");
      fs.stat(file, (err, stat) => {
        if (err || !stat.isFile()) return text(res, 404, "not found");
        res.writeHead(200, {
          "content-type": contentType(file),
          "cache-control": "no-store",
        });
        fs.createReadStream(file).pipe(res);
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  return {
    server,
    platform: { db, auth, catalog, library, launch, usersRoot, stateRoot },
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
      return new Promise(resolve => {
        clearInterval(cleanup);
        for (const session of fsSessions.values()) session.drive.closeAll();
        fsSessions.clear();
        server.close(() => {
          try { db.close(); } catch {}
          resolve();
        });
      });
    },
  };
}

if (require.main === module) {
  const app = createAppServer({
    stateRoot: process.env.DOS_CLOUD_STATE_ROOT || ROOT,
  });
  app.listen().then(addr => {
    console.log("DOS Cloud Phase 3 listening on http://0.0.0.0:" + addr.port);
    console.log("Demo users: alice, bob, carol, dave, erin / password: doscloud");
  });
}

module.exports = { createAppServer };
