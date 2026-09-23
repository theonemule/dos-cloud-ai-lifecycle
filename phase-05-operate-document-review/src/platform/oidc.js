const crypto = require("node:crypto");
const { nowIso } = require("./database");

function randomBase64Url(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function sha256Base64Url(value) {
  return crypto.createHash("sha256").update(String(value)).digest("base64url");
}

function normalizeIssuer(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function isLoopbackHostname(hostname) {
  return hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]";
}

function assertHttpsOrLoopback(value, label, allowHttp = false) {
  const url = new URL(value);
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && (allowHttp || isLoopbackHostname(url.hostname))) return url;
  throw new Error(label + " must use HTTPS");
}

function sanitizeUsername(value) {
  let username = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/@.*$/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[-_.]+$/, "");
  if (!username) username = "oidc-user";
  if (username.length < 3) username = "oidc-" + username;
  return username.slice(0, 24);
}

function sanitizeDisplayName(value, fallback) {
  let name = String(value || fallback || "OIDC User")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) name = String(fallback || "OIDC User");
  return name.slice(0, 80);
}

function claimValue(claims, name) {
  if (!name) return undefined;
  return claims?.[name];
}

function createOidcService({ db, auth, config = {} }) {
  const issuer = normalizeIssuer(config.issuer);
  const clientId = String(config.clientId || "").trim();
  const clientSecret = config.clientSecret ? String(config.clientSecret) : "";
  const providerName = String(config.providerName || "Single Sign-On").trim() || "Single Sign-On";
  const scopes = String(config.scopes || "openid profile email")
    .split(/\s+/)
    .filter(Boolean);
  const usernameClaim = String(config.usernameClaim || "preferred_username");
  const nameClaim = String(config.nameClaim || "name");
  const emailClaim = String(config.emailClaim || "email");
  const emailVerifiedClaim = String(config.emailVerifiedClaim || "email_verified");
  const configuredRedirectUri = config.redirectUri ? String(config.redirectUri).trim() : "";
  const autoProvision = config.autoProvision !== false;
  const allowHttp = config.allowHttp === true;
  const enabled = Boolean(issuer && clientId);

  let discoveryCache = null;
  let discoveryCachedAt = 0;
  const jwksCache = new Map();

  if (enabled) {
    assertHttpsOrLoopback(issuer, "OIDC issuer", allowHttp);
    if (configuredRedirectUri) {
      assertHttpsOrLoopback(configuredRedirectUri, "OIDC redirect URI", allowHttp);
    }
    if (!scopes.includes("openid")) scopes.unshift("openid");
  }

  async function fetchJson(url, options = {}, label = "OIDC request") {
    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(10_000),
      headers: {
        accept: "application/json",
        ...(options.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(label + " failed"), {
        statusCode: 502,
        code: "EOIDC",
      });
    }
    return body;
  }

  async function discovery() {
    if (!enabled) {
      throw Object.assign(new Error("OIDC is not configured"), { statusCode: 404 });
    }
    if (discoveryCache && Date.now() - discoveryCachedAt < 5 * 60 * 1000) {
      return discoveryCache;
    }

    const discoveryUrl = issuer + "/.well-known/openid-configuration";
    const metadata = await fetchJson(discoveryUrl, {}, "OIDC discovery");
    if (normalizeIssuer(metadata.issuer) !== issuer) {
      throw Object.assign(new Error("OIDC discovery issuer mismatch"), {
        statusCode: 502,
        code: "EOIDCISSUER",
      });
    }

    for (const [field, label] of [
      ["authorization_endpoint", "authorization endpoint"],
      ["token_endpoint", "token endpoint"],
      ["jwks_uri", "JWKS endpoint"],
    ]) {
      if (!metadata[field]) {
        throw Object.assign(new Error("OIDC discovery is missing " + label), {
          statusCode: 502,
          code: "EOIDCMETADATA",
        });
      }
      assertHttpsOrLoopback(metadata[field], "OIDC " + label, allowHttp);
    }

    discoveryCache = metadata;
    discoveryCachedAt = Date.now();
    return metadata;
  }

  function callbackUri(req) {
    if (configuredRedirectUri) return configuredRedirectUri;
    const host = String(req.headers.host || "").trim();
    if (!host || /[\s/\\]/.test(host)) {
      throw Object.assign(new Error("a valid Host header is required for OIDC"), { statusCode: 400 });
    }
    const protocol = req.socket?.encrypted ? "https" : "http";
    const value = protocol + "://" + host + "/api/auth/oidc/callback";
    assertHttpsOrLoopback(value, "derived OIDC redirect URI", allowHttp);
    return value;
  }

  async function cleanExpiredFlows() {
    await db.run("DELETE FROM oidc_flows WHERE expires_at <= ?", nowIso());
  }

  async function flowByState(state) {
    if (!state) return null;
    return db.get(`
      SELECT * FROM oidc_flows
      WHERE state_hash = ? AND expires_at > ?
    `, sha256Base64Url(state), nowIso());
  }

  async function deleteFlow(state) {
    if (!state) return;
    await db.run("DELETE FROM oidc_flows WHERE state_hash = ?", sha256Base64Url(state));
  }

  async function begin(req, { linkUserId = null } = {}) {
    if (!enabled) {
      throw Object.assign(new Error("OIDC is not configured"), { statusCode: 404 });
    }

    await cleanExpiredFlows();
    const metadata = await discovery();
    const state = randomBase64Url(32);
    const nonce = randomBase64Url(32);
    const codeVerifier = randomBase64Url(48);
    const codeChallenge = sha256Base64Url(codeVerifier);
    const redirectUri = callbackUri(req);
    const created = new Date();
    const expires = new Date(created.getTime() + 10 * 60 * 1000);

    await db.run(`
      INSERT INTO oidc_flows(
        state_hash,issuer,code_verifier,nonce,redirect_uri,link_user_id,created_at,expires_at
      ) VALUES (?,?,?,?,?,?,?,?)
    `,
      sha256Base64Url(state),
      issuer,
      codeVerifier,
      nonce,
      redirectUri,
      linkUserId,
      created.toISOString(),
      expires.toISOString()
    );

    const url = new URL(metadata.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");

    return { url: url.toString(), expiresAt: expires.toISOString() };
  }

  async function exchangeCode(metadata, flow, code) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: flow.redirect_uri,
      code_verifier: flow.code_verifier,
    });
    const headers = {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    };

    const methods = Array.isArray(metadata.token_endpoint_auth_methods_supported)
      ? metadata.token_endpoint_auth_methods_supported
      : [];

    if (clientSecret) {
      if (methods.includes("client_secret_post") && !methods.includes("client_secret_basic")) {
        body.set("client_id", clientId);
        body.set("client_secret", clientSecret);
      } else {
        headers.authorization = "Basic " + Buffer.from(clientId + ":" + clientSecret).toString("base64");
      }
    } else {
      body.set("client_id", clientId);
    }

    const response = await fetch(metadata.token_endpoint, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const tokenSet = await response.json().catch(() => ({}));
    if (!response.ok || !tokenSet.id_token) {
      throw Object.assign(new Error("OIDC token exchange failed"), {
        statusCode: 401,
        code: "EOIDCTOKEN",
      });
    }
    return tokenSet;
  }

  async function validateIdToken(metadata, idToken, expectedNonce) {
    const jose = await import("jose");
    let jwks = jwksCache.get(metadata.jwks_uri);
    if (!jwks) {
      jwks = jose.createRemoteJWKSet(new URL(metadata.jwks_uri));
      jwksCache.set(metadata.jwks_uri, jwks);
    }

    const { payload } = await jose.jwtVerify(idToken, jwks, {
      issuer: metadata.issuer,
      audience: clientId,
      clockTolerance: 5,
    });

    if (!payload.sub) {
      throw Object.assign(new Error("OIDC ID token is missing subject"), {
        statusCode: 401,
        code: "EOIDCCLAIMS",
      });
    }
    if (payload.nonce !== expectedNonce) {
      throw Object.assign(new Error("OIDC nonce validation failed"), {
        statusCode: 401,
        code: "EOIDCNONCE",
      });
    }

    if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId) {
      throw Object.assign(new Error("OIDC authorized-party validation failed"), {
        statusCode: 401,
        code: "EOIDCAZP",
      });
    }
    if (payload.azp && payload.azp !== clientId) {
      throw Object.assign(new Error("OIDC authorized-party validation failed"), {
        statusCode: 401,
        code: "EOIDCAZP",
      });
    }

    return payload;
  }

  async function loadUserInfo(metadata, accessToken, subject) {
    if (!metadata.userinfo_endpoint || !accessToken) return {};
    assertHttpsOrLoopback(metadata.userinfo_endpoint, "OIDC userinfo endpoint", allowHttp);

    const claims = await fetchJson(metadata.userinfo_endpoint, {
      headers: { authorization: "Bearer " + accessToken },
    }, "OIDC userinfo");

    if (claims.sub && claims.sub !== subject) {
      throw Object.assign(new Error("OIDC userinfo subject mismatch"), {
        statusCode: 401,
        code: "EOIDCSUBJECT",
      });
    }
    return claims;
  }

  async function allocateUsername(claims, subject) {
    const preferred =
      claimValue(claims, usernameClaim) ||
      claimValue(claims, emailClaim) ||
      subject;
    const base = sanitizeUsername(preferred);
    let candidate = base;
    let attempt = 0;
    while (await auth.getUserByUsername(candidate)) {
      attempt++;
      const suffix = "-" + sha256Base64Url(issuer + ":" + subject + ":" + attempt)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .slice(0, 6);
      candidate = (base.slice(0, Math.max(3, 32 - suffix.length)) + suffix).slice(0, 32);
      if (attempt > 20) {
        candidate = "oidc-" + randomBase64Url(8).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20);
        break;
      }
    }
    return candidate;
  }

  async function complete(callbackUrl) {
    if (!enabled) {
      throw Object.assign(new Error("OIDC is not configured"), { statusCode: 404 });
    }

    const url = callbackUrl instanceof URL ? callbackUrl : new URL(String(callbackUrl));
    const state = url.searchParams.get("state");
    const flow = await flowByState(state);
    if (!flow) {
      throw Object.assign(new Error("OIDC state is invalid or expired"), {
        statusCode: 401,
        code: "EOIDCSTATE",
      });
    }

    // State is single-use even if the downstream provider exchange fails.
    await deleteFlow(state);

    if (flow.issuer !== issuer) {
      throw Object.assign(new Error("OIDC flow issuer mismatch"), {
        statusCode: 401,
        code: "EOIDCISSUER",
      });
    }

    if (url.searchParams.get("error")) {
      throw Object.assign(new Error("OIDC provider returned an authorization error"), {
        statusCode: 401,
        code: "EOIDCAUTH",
      });
    }

    const code = url.searchParams.get("code");
    if (!code) {
      throw Object.assign(new Error("OIDC callback is missing authorization code"), {
        statusCode: 400,
        code: "EOIDCCODE",
      });
    }

    const metadata = await discovery();
    const tokenSet = await exchangeCode(metadata, flow, code);
    const idClaims = await validateIdToken(metadata, tokenSet.id_token, flow.nonce);
    const userInfo = await loadUserInfo(metadata, tokenSet.access_token, idClaims.sub);
    const claims = { ...idClaims, ...userInfo, sub: idClaims.sub };

    const email = claimValue(claims, emailClaim);
    const emailVerified = claimValue(claims, emailVerifiedClaim) === true;
    let identity = await auth.getOidcIdentity(issuer, claims.sub);
    let user;
    let linked = false;
    let provisioned = false;

    if (flow.link_user_id) {
      await auth.linkOidcIdentity(flow.link_user_id, {
        issuer,
        subject: claims.sub,
        email,
        emailVerified,
      });
      user = await auth.getUserById(flow.link_user_id);
      linked = true;
    } else if (identity) {
      await auth.touchOidcIdentity(issuer, claims.sub, { email, emailVerified });
      user = await auth.getUserById(identity.user_id);
    } else {
      if (!autoProvision) {
        throw Object.assign(new Error("OIDC account is not provisioned"), {
          statusCode: 403,
          code: "EOIDCPROVISION",
        });
      }

      const username = await allocateUsername(claims, claims.sub);
      const displayName = sanitizeDisplayName(
        claimValue(claims, nameClaim) ||
          claimValue(claims, usernameClaim) ||
          email,
        username
      );
      user = await auth.createExternalUser({ username, displayName });
      await auth.linkOidcIdentity(user.id, {
        issuer,
        subject: claims.sub,
        email,
        emailVerified,
      });
      provisioned = true;
    }

    if (!user) {
      throw Object.assign(new Error("OIDC user resolution failed"), {
        statusCode: 500,
        code: "EOIDCUSER",
      });
    }

    const token = await auth.createSession(user.id);
    return {
      user,
      token,
      linked,
      provisioned,
      issuer,
      subject: claims.sub,
    };
  }

  function publicConfig() {
    return enabled ? {
      enabled: true,
      providerName,
      issuer,
      linkSupported: true,
    } : {
      enabled: false,
      providerName,
      linkSupported: false,
    };
  }

  return {
    enabled,
    issuer,
    providerName,
    begin,
    complete,
    cleanExpiredFlows,
    publicConfig,
  };
}

module.exports = {
  createOidcService,
  sanitizeUsername,
  sanitizeDisplayName,
  sha256Base64Url,
};
