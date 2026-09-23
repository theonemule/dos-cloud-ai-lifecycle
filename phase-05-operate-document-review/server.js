const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { DriveStore } = require("./src/drive-store");
const { encodePacket, decodePacket } = require("./src/protocol");
const { openDatabase } = require("./src/platform/database");
const { createAuthService } = require("./src/platform/auth");
const { createCatalogService } = require("./src/platform/catalog");
const { createLibraryService } = require("./src/platform/library");
const { createLaunchService } = require("./src/platform/launch");
const { createOidcService } = require("./src/platform/oidc");
const { createLogger } = require("./src/platform/logger");
const { json, text, readBody, readJson, handleError } = require("./src/platform/http-utils");
const {
  parseAllowedOrigins,
  requestOriginAllowed,
  assertMutationOrigin,
  corsHeaders,
  applySecurityHeaders,
  clientKey,
  createRateLimiter,
} = require("./src/platform/security");

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

async function createAppServer(options = {}) {
  const httpsEnabled = options.httpsEnabled ?? (process.env.DOS_CLOUD_HTTPS === "true");
  const port = Number(options.port ?? process.env.PORT ?? (httpsEnabled ? 8443 : 8080));
  const stateRoot = path.resolve(options.stateRoot || ROOT);
  const tlsKeyPath = path.resolve(options.tlsKeyPath ?? process.env.DOS_CLOUD_TLS_KEY ?? path.join(ROOT, "certs", "dev-key.pem"));
  const tlsCertPath = path.resolve(options.tlsCertPath ?? process.env.DOS_CLOUD_TLS_CERT ?? path.join(ROOT, "certs", "dev-cert.pem"));
  const dbPath = path.resolve(options.dbPath || path.join(stateRoot, "var", "doscloud.db"));
  const databaseUrl = options.databaseUrl || process.env.DOS_CLOUD_DATABASE_URL || null;
  const usersRoot = path.resolve(
    options.usersRoot ||
    process.env.DOS_CLOUD_USERS_ROOT ||
    path.join(stateRoot, "user-data", "users")
  );
  const securityOptions = options.security || {};
  const allowedOrigins = parseAllowedOrigins(options.allowedOrigins ?? process.env.DOS_CLOUD_ALLOWED_ORIGINS);
  const oidcInput = options.oidc || {};
  const oidcOptions = {
    issuer: oidcInput.issuer ?? process.env.DOS_CLOUD_OIDC_ISSUER,
    clientId: oidcInput.clientId ?? process.env.DOS_CLOUD_OIDC_CLIENT_ID,
    clientSecret: oidcInput.clientSecret ?? process.env.DOS_CLOUD_OIDC_CLIENT_SECRET,
    redirectUri: oidcInput.redirectUri ?? process.env.DOS_CLOUD_OIDC_REDIRECT_URI,
    providerName: oidcInput.providerName ?? process.env.DOS_CLOUD_OIDC_PROVIDER_NAME,
    scopes: oidcInput.scopes ?? process.env.DOS_CLOUD_OIDC_SCOPES,
    usernameClaim: oidcInput.usernameClaim ?? process.env.DOS_CLOUD_OIDC_USERNAME_CLAIM,
    nameClaim: oidcInput.nameClaim ?? process.env.DOS_CLOUD_OIDC_NAME_CLAIM,
    emailClaim: oidcInput.emailClaim ?? process.env.DOS_CLOUD_OIDC_EMAIL_CLAIM,
    emailVerifiedClaim: oidcInput.emailVerifiedClaim ?? process.env.DOS_CLOUD_OIDC_EMAIL_VERIFIED_CLAIM,
    autoProvision: oidcInput.autoProvision ?? (process.env.DOS_CLOUD_OIDC_AUTO_PROVISION !== "false"),
    allowHttp: oidcInput.allowHttp ?? (process.env.DOS_CLOUD_OIDC_ALLOW_HTTP === "true"),
  };
  const redirectUsesHttps = String(oidcOptions.redirectUri || "").toLowerCase().startsWith("https://");
  const secureCookies = options.secureCookies ??
    (httpsEnabled || process.env.DOS_CLOUD_SECURE_COOKIES === "true" || redirectUsesHttps);
  const localAuthEnabled = options.localAuthEnabled ??
    (process.env.DOS_CLOUD_LOCAL_AUTH_ENABLED !== "false");
  const localRegistrationEnabled = options.localRegistrationEnabled ??
    (localAuthEnabled && process.env.DOS_CLOUD_LOCAL_REGISTRATION_ENABLED !== "false");
  const logger = options.logger || createLogger({ phase: 5 });

  const db = await openDatabase(databaseUrl || dbPath);
  const auth = createAuthService({ db, usersRoot, secureCookies });
  const oidc = createOidcService({ db, auth, config: oidcOptions });
  const catalog = await createCatalogService({ db, manifestsRoot: MANIFESTS_ROOT });
  const library = createLibraryService({ db, catalog, packagesRoot: PACKAGES_ROOT, auth });
  const launch = createLaunchService({ db, catalog, library });
  const loginLimiter = createRateLimiter({
    max: securityOptions.loginMax ?? 30,
    windowMs: securityOptions.loginWindowMs ?? 5 * 60 * 1000,
    label: "login",
  });
  const registerLimiter = createRateLimiter({
    max: securityOptions.registerMax ?? 10,
    windowMs: securityOptions.registerWindowMs ?? 60 * 60 * 1000,
    label: "registration",
  });

  if (options.seedDemoUsers === true || (options.seedDemoUsers == null && process.env.DOS_CLOUD_SEED_DEMO_USERS === "true")) {
    await auth.seedDemoUsers();
  }

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

  const cleanup = setInterval(async () => {
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const [key, session] of fsSessions) {
      if (session.lastSeen < cutoff) {
        fsSessions.delete(key);
        session.drive.closeAll();
      }
    }
    try {
      await db.run("DELETE FROM launch_sessions WHERE expires_at <= ?", new Date().toISOString());
      await db.run("DELETE FROM sessions WHERE expires_at <= ?", new Date().toISOString());
      await oidc.cleanExpiredFlows();
    } catch (err) {
      logger.warn("background_cleanup_failed", { error: err });
    }
  }, 60 * 1000);
  cleanup.unref();

  async function handleApi(req, res, url) {
    assertMutationOrigin(req, allowedOrigins);

    if (url.pathname === "/api/auth/methods" && req.method === "GET") {
      return json(res, 200, {
        local: {
          enabled: localAuthEnabled,
          registrationEnabled: localRegistrationEnabled,
        },
        oidc: oidc.publicConfig(),
      });
    }

    if (url.pathname === "/api/auth/me" && req.method === "GET") {
      const user = await auth.getUserFromRequest(req);
      return json(res, 200, {
        user: auth.publicUser(user),
        auth: user && oidc.enabled ? {
          oidcLinked: Boolean(await auth.getOidcIdentityForUser(user.id, oidc.issuer)),
        } : {
          oidcLinked: false,
        },
      });
    }

    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      if (!localAuthEnabled) {
        return json(res, 403, { error: "local sign-in is disabled", code: "ELOCALAUTH" });
      }
      loginLimiter.consume(clientKey(req));
      const body = await readJson(req);
      const result = await auth.login(body.username, body.password);
      logger.info("auth_login_succeeded", { requestId: req.requestId, userId: result.user.id, username: result.user.username });
      return json(res, 200, { user: auth.publicUser(result.user) }, {
        "set-cookie": auth.sessionCookie(result.token),
      });
    }

    if (url.pathname === "/api/auth/register" && req.method === "POST") {
      if (!localRegistrationEnabled) {
        return json(res, 403, { error: "local registration is disabled", code: "ELOCALREGISTER" });
      }
      registerLimiter.consume(clientKey(req));
      const body = await readJson(req);
      const user = await auth.createUser(body);
      const token = (await auth.login(body.username, body.password)).token;
      logger.info("auth_user_registered", { requestId: req.requestId, userId: user.id, username: user.username });
      return json(res, 201, { user: auth.publicUser(user) }, {
        "set-cookie": auth.sessionCookie(token),
      });
    }

    if (url.pathname === "/api/auth/oidc/start" && req.method === "GET") {
      const started = await oidc.begin(req);
      logger.info("oidc_login_started", { requestId: req.requestId, issuer: oidc.issuer });
      res.writeHead(302, {
        location: started.url,
        "cache-control": "no-store",
      });
      return res.end();
    }

    if (url.pathname === "/api/auth/oidc/link/start" && req.method === "POST") {
      const user = await auth.requireUser(req);
      const started = await oidc.begin(req, { linkUserId: user.id });
      logger.info("oidc_link_started", { requestId: req.requestId, userId: user.id, issuer: oidc.issuer });
      return json(res, 200, { url: started.url, expiresAt: started.expiresAt });
    }

    if (url.pathname === "/api/auth/oidc/callback" && req.method === "GET") {
      const result = await oidc.complete(url);
      logger.info("oidc_login_completed", {
        requestId: req.requestId,
        userId: result.user.id,
        issuer: result.issuer,
        linked: result.linked,
        provisioned: result.provisioned,
      });
      res.writeHead(302, {
        location: "/",
        "set-cookie": auth.sessionCookie(result.token),
        "cache-control": "no-store",
      });
      return res.end();
    }

    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      const user = await auth.getUserFromRequest(req);
      await auth.logout(req);
      logger.info("auth_logout", { requestId: req.requestId, userId: user?.id || null });
      return json(res, 200, { ok: true }, { "set-cookie": auth.clearSessionCookie() });
    }

    if (url.pathname === "/api/catalog" && req.method === "GET") {
      const user = await auth.requireUser(req);
      return json(res, 200, { games: await catalog.listForUser(user.id) });
    }

    if (url.pathname === "/api/library" && req.method === "GET") {
      const user = await auth.requireUser(req);
      return json(res, 200, { games: await library.list(user.id) });
    }

    let match = url.pathname.match(/^\/api\/library\/([a-z0-9-]+)\/install$/);
    if (match && req.method === "POST") {
      const user = await auth.requireUser(req);
      const result = await library.install(user, match[1]);
      logger.info("game_installed", { requestId: req.requestId, userId: user.id, gameId: match[1], alreadyInstalled: Boolean(result.alreadyInstalled) });
      return json(res, 200, result);
    }

    match = url.pathname.match(/^\/api\/library\/([a-z0-9-]+)$/);
    if (match && req.method === "DELETE") {
      const user = await auth.requireUser(req);
      const result = await library.uninstall(user, match[1]);
      logger.info("game_uninstalled", { requestId: req.requestId, userId: user.id, gameId: match[1] });
      return json(res, 200, result);
    }

    match = url.pathname.match(/^\/api\/library\/([a-z0-9-]+)\/launch$/);
    if (match && req.method === "POST") {
      const user = await auth.requireUser(req);
      const session = await launch.create(user, { mode: "game", gameId: match[1] });
      logger.info("game_launch_created", { requestId: req.requestId, userId: user.id, gameId: match[1], launchId: session.id });
      return json(res, 201, { session });
    }

    if (url.pathname === "/api/console/launch" && req.method === "POST") {
      const user = await auth.requireUser(req);
      const session = await launch.create(user, { mode: "console" });
      logger.info("console_launch_created", { requestId: req.requestId, userId: user.id, launchId: session.id });
      return json(res, 201, { session });
    }

    match = url.pathname.match(/^\/api\/launch\/([A-Za-z0-9_-]+)$/);
    if (match && req.method === "GET") {
      const user = await auth.requireUser(req);
      return json(res, 200, { launch: await launch.getConfig(user, match[1]) });
    }

    if (url.pathname === "/api/stats" && req.method === "GET") {
      const user = await auth.requireUser(req);
      return json(res, 200, metricsFor(user.id));
    }

    if (url.pathname === "/api/fs") {
      const origin = req.headers.origin;
      if (req.method === "OPTIONS" && origin && !requestOriginAllowed(req, allowedOrigins)) {
        return json(res, 403, { error: "request origin is not allowed", code: "EORIGIN" });
      }
      const cors = corsHeaders(req, allowedOrigins);

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
        const user = await auth.requireUser(req);
        const launchId = String(url.searchParams.get("launch") || "");
        if (!launchId) throw Object.assign(new Error("launch session required"), { statusCode: 403, code: "EACCES" });
        await launch.getOwned(user, launchId);
        const raw = await readBody(req, 4 * 1024 * 1024);
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
        logger.warn("filesystem_rpc_failed", {
          requestId: req.requestId,
          operation: request?.header?.op || null,
          code: err.code || null,
          statusCode: err.statusCode || null,
        });
        const response = encodePacket({
          id,
          ok: false,
          code: err.code || (err.statusCode === 401 ? "EACCES" : "EIO"),
          error: err.statusCode === 401 ? "authentication required" : "filesystem operation failed",
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

  const requestHandler = async (req, res) => {
    const url = new URL(req.url, (req.socket.encrypted ? "https" : "http") + "://localhost");
    const incomingRequestId = String(req.headers["x-request-id"] || "");
    const requestId = /^[A-Za-z0-9_.:-]{1,128}$/.test(incomingRequestId) ? incomingRequestId : crypto.randomUUID();
    const startedAt = process.hrtime.bigint();
    req.requestId = requestId;
    res.setHeader("x-request-id", requestId);
    res.once("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const eventData = {
        requestId,
        method: req.method,
        path: url.pathname,
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        remoteAddress: req.socket.remoteAddress || null,
      };
      if (url.pathname === "/health" || url.pathname === "/ready") logger.debug("http_request", eventData);
      else logger.info("http_request", eventData);
    });
    applySecurityHeaders(res, { allowUnsafeEval: url.pathname === "/runtime.html" });
    try {
      if (url.pathname === "/health") {
        return json(res, 200, {
          ok: true,
          phase: 5,
          catalogGames: catalog.count(),
        });
      }

      if (url.pathname === "/ready") {
        try {
          await db.ping();
          fs.mkdirSync(usersRoot, { recursive: true });
          fs.accessSync(usersRoot, fs.constants.R_OK | fs.constants.W_OK);
          return json(res, 200, {
            ready: true,
            phase: 5,
            database: db.kind,
            filesystem: "direct",
          });
        } catch (err) {
          logger.error("readiness_failed", { requestId, error: err });
          return json(res, 503, { ready: false, phase: 5 });
        }
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
      const statusCode = Number(err.statusCode) || 500;
      const log = statusCode >= 500 ? logger.error.bind(logger) : logger.warn.bind(logger);
      log("request_failed", {
        requestId,
        method: req.method,
        path: url.pathname,
        statusCode,
        code: err.code || null,
        error: err,
      });
      handleError(res, err);
    }
  };

  let server;
  if (httpsEnabled) {
    if (!fs.existsSync(tlsKeyPath) || !fs.existsSync(tlsCertPath)) {
      throw Object.assign(new Error(
        "HTTPS is enabled but the TLS key/certificate is missing. Run npm run cert:dev or configure DOS_CLOUD_TLS_KEY and DOS_CLOUD_TLS_CERT."
      ), { code: "ETLSCONFIG" });
    }
    server = https.createServer({
      key: fs.readFileSync(tlsKeyPath),
      cert: fs.readFileSync(tlsCertPath),
      minVersion: "TLSv1.2",
    }, requestHandler);
  } else {
    server = http.createServer(requestHandler);
  }

  return {
    server,
    platform: {
      db,
      auth,
      oidc,
      catalog,
      library,
      launch,
      usersRoot,
      stateRoot,
      dbPath,
      databaseUrl,
      localAuthEnabled,
      localRegistrationEnabled,
      logger,
      httpsEnabled,
      tlsKeyPath: httpsEnabled ? tlsKeyPath : null,
      tlsCertPath: httpsEnabled ? tlsCertPath : null,
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "0.0.0.0", () => {
          server.off("error", reject);
          resolve(server.address());
        });
      });
    },
    async close() {
      clearInterval(cleanup);
      for (const session of fsSessions.values()) session.drive.closeAll();
      fsSessions.clear();

      await new Promise(resolve => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
      });

      try {
        await db.close();
      } finally {
        try { logger.close(); } catch {}
      }
    },
  };
}

if (require.main === module) {
  (async () => {
    const app = await createAppServer({
      stateRoot: process.env.DOS_CLOUD_STATE_ROOT || ROOT,
    });

    async function shutdown(signal) {
      app.platform.logger.info("server_shutdown_started", { signal });
      try {
        await app.close();
        process.exit(0);
      } catch (err) {
        app.platform.logger.error("server_shutdown_failed", { signal, error: err });
        process.exit(1);
      }
    }

    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));

    process.on("unhandledRejection", err => {
      app.platform.logger.error("unhandled_rejection", { error: err });
    });

    const addr = await app.listen();
    const scheme = app.platform.httpsEnabled ? "https" : "http";
    app.platform.logger.info("server_started", {
      scheme,
      address: "0.0.0.0",
      port: addr.port,
      stateRoot: app.platform.stateRoot,
      database: app.platform.db.kind,
      localAuthEnabled: app.platform.localAuthEnabled,
      oidcEnabled: app.platform.oidc.enabled,
    });
  })().catch(err => {
    const logger = createLogger({ phase: 5 });
    logger.error("server_start_failed", { error: err });
    process.exitCode = 1;
  });
}

module.exports = { createAppServer };
