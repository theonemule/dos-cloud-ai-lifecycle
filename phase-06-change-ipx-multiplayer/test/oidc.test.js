const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const { startApp, expectOkLogin } = require("./helpers");

function sha256Base64Url(value) {
  return crypto.createHash("sha256").update(String(value)).digest("base64url");
}

async function readForm(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

async function createOidcProvider() {
  const jose = await import("jose");
  const { publicKey, privateKey } = await jose.generateKeyPair("RS256");
  const jwk = await jose.exportJWK(publicKey);
  jwk.kid = "dos-cloud-test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";

  const codes = new Map();
  const accessTokens = new Map();
  let issuer = "";
  const state = {
    profile: {
      sub: "subject-001",
      preferred_username: "oidcuser",
      name: "OIDC User",
      email: "oidc@example.test",
      email_verified: true,
    },
    badNonce: false,
    lastAuthorization: null,
    tokenRequests: 0,
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, issuer || "http://127.0.0.1");

    function json(status, body) {
      const data = Buffer.from(JSON.stringify(body));
      res.writeHead(status, {
        "content-type": "application/json",
        "content-length": data.length,
        "cache-control": "no-store",
      });
      res.end(data);
    }

    if (url.pathname === "/.well-known/openid-configuration") {
      return json(200, {
        issuer,
        authorization_endpoint: issuer + "/authorize",
        token_endpoint: issuer + "/token",
        jwks_uri: issuer + "/jwks",
        userinfo_endpoint: issuer + "/userinfo",
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
      });
    }

    if (url.pathname === "/jwks") {
      return json(200, { keys: [jwk] });
    }

    if (url.pathname === "/authorize") {
      assert.equal(url.searchParams.get("response_type"), "code");
      assert.equal(url.searchParams.get("client_id"), "dos-cloud-test");
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert.ok(url.searchParams.get("state"));
      assert.ok(url.searchParams.get("nonce"));
      assert.ok(url.searchParams.get("code_challenge"));

      const code = crypto.randomBytes(18).toString("base64url");
      const record = {
        code,
        clientId: url.searchParams.get("client_id"),
        redirectUri: url.searchParams.get("redirect_uri"),
        state: url.searchParams.get("state"),
        nonce: url.searchParams.get("nonce"),
        codeChallenge: url.searchParams.get("code_challenge"),
        profile: { ...state.profile },
      };
      codes.set(code, record);
      state.lastAuthorization = record;

      const callback = new URL(record.redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", record.state);
      res.writeHead(302, { location: callback.toString(), "cache-control": "no-store" });
      return res.end();
    }

    if (url.pathname === "/token" && req.method === "POST") {
      state.tokenRequests++;
      const form = await readForm(req);
      assert.equal(form.get("grant_type"), "authorization_code");
      const code = form.get("code");
      const record = codes.get(code);
      if (!record) return json(400, { error: "invalid_grant" });
      codes.delete(code);

      assert.equal(form.get("redirect_uri"), record.redirectUri);
      assert.equal(sha256Base64Url(form.get("code_verifier")), record.codeChallenge);
      assert.equal(form.get("client_id"), "dos-cloud-test");

      const claims = {
        ...record.profile,
        nonce: state.badNonce ? "wrong-nonce" : record.nonce,
      };
      const idToken = await new jose.SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
        .setIssuer(issuer)
        .setAudience("dos-cloud-test")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);

      const accessToken = crypto.randomBytes(24).toString("base64url");
      accessTokens.set(accessToken, { ...record.profile });
      return json(200, {
        token_type: "Bearer",
        access_token: accessToken,
        id_token: idToken,
        expires_in: 300,
      });
    }

    if (url.pathname === "/userinfo") {
      const authz = String(req.headers.authorization || "");
      const token = authz.startsWith("Bearer ") ? authz.slice(7) : "";
      const profile = accessTokens.get(token);
      if (!profile) return json(401, { error: "invalid_token" });
      return json(200, profile);
    }

    return json(404, { error: "not_found" });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  issuer = "http://127.0.0.1:" + address.port;

  return {
    issuer,
    state,
    async close() {
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function startOidcApp(provider, options = {}) {
  return startApp({
    oidc: {
      issuer: provider.issuer,
      clientId: "dos-cloud-test",
      providerName: "Test Identity",
      allowHttp: true,
      autoProvision: true,
      ...(options.oidc || {}),
    },
    ...options,
  });
}

async function beginLogin(ctx) {
  const response = await fetch(ctx.base + "/api/auth/oidc/start", {
    redirect: "manual",
  });
  assert.equal(response.status, 302);
  const location = response.headers.get("location");
  assert.ok(location);
  return new URL(location);
}

async function authorizeAtProvider(authUrl) {
  const response = await fetch(authUrl, { redirect: "manual" });
  assert.equal(response.status, 302);
  const location = response.headers.get("location");
  assert.ok(location);
  return new URL(location);
}

async function finishCallback(callbackUrl) {
  const response = await fetch(callbackUrl, { redirect: "manual" });
  return {
    response,
    cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
  };
}

async function fullOidcLogin(ctx) {
  const authUrl = await beginLogin(ctx);
  const callbackUrl = await authorizeAtProvider(authUrl);
  const finished = await finishCallback(callbackUrl);
  assert.equal(finished.response.status, 302);
  assert.equal(finished.response.headers.get("location"), "/");
  assert.ok(finished.cookie);
  return { ...finished, authUrl, callbackUrl };
}

test("OIDC: methods advertise provider and authorization start uses PKCE, state, and nonce", async () => {
  const provider = await createOidcProvider();
  const ctx = await startOidcApp(provider);
  try {
    const methods = await ctx.request("/api/auth/methods");
    assert.equal(methods.response.status, 200);
    assert.equal(methods.body.oidc.enabled, true);
    assert.equal(methods.body.oidc.providerName, "Test Identity");

    const authUrl = await beginLogin(ctx);
    assert.equal(authUrl.origin, provider.issuer);
    assert.equal(authUrl.pathname, "/authorize");
    assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
    assert.ok(authUrl.searchParams.get("code_challenge")?.length >= 40);
    assert.ok(authUrl.searchParams.get("state")?.length >= 32);
    assert.ok(authUrl.searchParams.get("nonce")?.length >= 32);
    assert.match(authUrl.searchParams.get("scope") || "", /openid/);
  } finally {
    await ctx.close();
    await provider.close();
  }
});

test("OIDC: full authorization-code flow auto-provisions and reuses the same issuer/subject identity", async () => {
  const provider = await createOidcProvider();
  const ctx = await startOidcApp(provider, { seedDemoUsers: false });
  try {
    const first = await fullOidcLogin(ctx);
    let me = await ctx.request("/api/auth/me", first.cookie);
    assert.equal(me.response.status, 200);
    assert.equal(me.body.user.username, "oidcuser");
    assert.equal(me.body.user.displayName, "OIDC User");
    assert.equal(me.body.auth.oidcLinked, true);
    const firstId = me.body.user.id;

    const identity = await ctx.app.platform.auth.getOidcIdentity(provider.issuer, "subject-001");
    assert.equal(identity.user_id, firstId);
    assert.equal(identity.email, "oidc@example.test");
    assert.equal(identity.email_verified, 1);

    const second = await fullOidcLogin(ctx);
    me = await ctx.request("/api/auth/me", second.cookie);
    assert.equal(me.body.user.id, firstId);
    assert.equal(ctx.app.platform.db.prepare("SELECT COUNT(*) AS n FROM users").get().n, 1);
  } finally {
    await ctx.close();
    await provider.close();
  }
});

test("OIDC: username or email similarity never silently links to an existing local account", async () => {
  const provider = await createOidcProvider();
  provider.state.profile = {
    sub: "external-alice",
    preferred_username: "alice",
    name: "External Alice",
    email: "alice@example.test",
    email_verified: true,
  };
  const ctx = await startOidcApp(provider, { seedDemoUsers: true });
  try {
    const localAlice = await ctx.app.platform.auth.getUserByUsername("alice");
    const result = await fullOidcLogin(ctx);
    const me = await ctx.request("/api/auth/me", result.cookie);

    assert.notEqual(me.body.user.id, localAlice.id);
    assert.notEqual(me.body.user.username, "alice");
    assert.match(me.body.user.username, /^alice-/);

    const identity = await ctx.app.platform.auth.getOidcIdentity(provider.issuer, "external-alice");
    assert.notEqual(identity.user_id, localAlice.id);
  } finally {
    await ctx.close();
    await provider.close();
  }
});

test("OIDC: explicit authenticated link attaches provider identity to that exact account", async () => {
  const provider = await createOidcProvider();
  provider.state.profile = {
    sub: "alice-sso-subject",
    preferred_username: "someone-else",
    name: "Alice via Identity Provider",
    email: "alice@identity.test",
    email_verified: true,
  };
  const ctx = await startOidcApp(provider, { seedDemoUsers: true });
  try {
    const alice = await ctx.login("alice");
    expectOkLogin(alice);

    const link = await ctx.request("/api/auth/oidc/link/start", alice.cookie, { method: "POST" });
    assert.equal(link.response.status, 200);
    const callbackUrl = await authorizeAtProvider(new URL(link.body.url));
    const finished = await finishCallback(callbackUrl);
    assert.equal(finished.response.status, 302);
    assert.ok(finished.cookie);

    const me = await ctx.request("/api/auth/me", finished.cookie);
    assert.equal(me.body.user.id, alice.user.id);
    assert.equal(me.body.user.username, "alice");
    assert.equal(me.body.auth.oidcLinked, true);

    const identity = await ctx.app.platform.auth.getOidcIdentity(provider.issuer, "alice-sso-subject");
    assert.equal(identity.user_id, alice.user.id);
  } finally {
    await ctx.close();
    await provider.close();
  }
});

test("OIDC: invalid state is rejected and nonce failure consumes the flow", async () => {
  const provider = await createOidcProvider();
  const ctx = await startOidcApp(provider);
  try {
    let response = await fetch(ctx.base + "/api/auth/oidc/callback?code=fake&state=not-a-real-state", {
      redirect: "manual",
    });
    assert.equal(response.status, 401);
    let body = await response.json();
    assert.equal(body.code, "EOIDCSTATE");

    const authUrl = await beginLogin(ctx);
    const callbackUrl = await authorizeAtProvider(authUrl);
    provider.state.badNonce = true;

    response = await fetch(callbackUrl, { redirect: "manual" });
    assert.equal(response.status, 401);
    body = await response.json();
    assert.equal(body.code, "EOIDCNONCE");

    provider.state.badNonce = false;
    response = await fetch(callbackUrl, { redirect: "manual" });
    assert.equal(response.status, 401);
    body = await response.json();
    assert.equal(body.code, "EOIDCSTATE");
  } finally {
    await ctx.close();
    await provider.close();
  }
});

test("OIDC: local authentication can be disabled while SSO remains available", async () => {
  const provider = await createOidcProvider();
  const ctx = await startOidcApp(provider, {
    seedDemoUsers: true,
    localAuthEnabled: false,
    localRegistrationEnabled: false,
  });
  try {
    const methods = await ctx.request("/api/auth/methods");
    assert.equal(methods.body.local.enabled, false);
    assert.equal(methods.body.local.registrationEnabled, false);
    assert.equal(methods.body.oidc.enabled, true);

    const login = await ctx.login("alice");
    assert.equal(login.response.status, 403);
    assert.equal(login.body.code, "ELOCALAUTH");

    const oidcLogin = await fullOidcLogin(ctx);
    const me = await ctx.request("/api/auth/me", oidcLogin.cookie);
    assert.equal(me.response.status, 200);
    assert.ok(me.body.user);
  } finally {
    await ctx.close();
    await provider.close();
  }
});
