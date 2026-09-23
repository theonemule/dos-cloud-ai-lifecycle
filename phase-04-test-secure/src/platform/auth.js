const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { nowIso } = require("./database");

const COOKIE_NAME = "doscloud_session";

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function randomId(prefix = "") {
  return prefix + crypto.randomBytes(16).toString("hex");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function hashPassword(password, saltHex) {
  return crypto.scryptSync(String(password), Buffer.from(saltHex, "hex"), 64).toString("hex");
}

function createPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: hashPassword(password, salt) };
}

function verifyPassword(password, user) {
  const candidate = Buffer.from(hashPassword(password, user.password_salt), "hex");
  const expected = Buffer.from(user.password_hash, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function buildSessionCookie(token, maxAgeSeconds, secureCookies) {
  const parts = [
    COOKIE_NAME + "=" + encodeURIComponent(token),
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=" + maxAgeSeconds,
  ];
  if (secureCookies) parts.push("Secure");
  return parts.join("; ");
}

function createAuthService({ db, usersRoot, secureCookies = false }) {
  fs.mkdirSync(usersRoot, { recursive: true });

  function getUserByUsername(username) {
    return db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(normalizeUsername(username));
  }

  function getUserById(id) {
    return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  }

  function createUser({ username, displayName, password }) {
    username = normalizeUsername(username);
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
      throw Object.assign(new Error("username must be 3-32 characters using letters, numbers, dot, underscore, or dash"), { statusCode: 400 });
    }
    const passwordValue = String(password || "");
    if (passwordValue.length < 8 || passwordValue.length > 128) {
      throw Object.assign(new Error("password must be 8-128 characters"), { statusCode: 400 });
    }
    const displayNameValue = String(displayName || username).trim();
    if (!displayNameValue || displayNameValue.length > 80 || /[\u0000-\u001f\u007f]/.test(displayNameValue)) {
      throw Object.assign(new Error("display name must be 1-80 printable characters"), { statusCode: 400 });
    }
    if (getUserByUsername(username)) {
      throw Object.assign(new Error("username already exists"), { statusCode: 409 });
    }

    const id = randomId("u_");
    const creds = createPassword(password);
    const createdAt = nowIso();

    db.prepare(`
      INSERT INTO users(id, username, display_name, password_hash, password_salt, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, username, displayNameValue, creds.hash, creds.salt, createdAt);

    const root = path.join(usersRoot, id, "C");
    fs.mkdirSync(path.join(root, "GAMES"), { recursive: true });
    fs.mkdirSync(path.join(root, "USER"), { recursive: true });
    fs.mkdirSync(path.join(root, "DOCS"), { recursive: true });

    return getUserById(id);
  }

  function createExternalUser({ username, displayName }) {
    return createUser({
      username,
      displayName,
      password: crypto.randomBytes(32).toString("base64url"),
    });
  }

  function getOidcIdentity(issuer, subject) {
    return db.prepare(`
      SELECT oi.*, u.username, u.display_name, u.created_at AS user_created_at
      FROM oidc_identities oi
      JOIN users u ON u.id = oi.user_id
      WHERE oi.issuer = ? AND oi.subject = ?
    `).get(String(issuer), String(subject));
  }

  function getOidcIdentityForUser(userId, issuer) {
    return db.prepare(`
      SELECT * FROM oidc_identities
      WHERE user_id = ? AND issuer = ?
    `).get(userId, String(issuer));
  }

  function linkOidcIdentity(userId, { issuer, subject, email = null, emailVerified = false }) {
    const existing = getOidcIdentity(issuer, subject);
    if (existing && existing.user_id !== userId) {
      throw Object.assign(new Error("OIDC identity is already linked to another account"), { statusCode: 409 });
    }

    const userProviderIdentity = getOidcIdentityForUser(userId, issuer);
    if (userProviderIdentity && userProviderIdentity.subject !== String(subject)) {
      throw Object.assign(new Error("this account is already linked to a different identity from this provider"), { statusCode: 409 });
    }

    const at = nowIso();
    db.prepare(`
      INSERT INTO oidc_identities(issuer,subject,user_id,email,email_verified,created_at,last_login_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(issuer,subject) DO UPDATE SET
        email=excluded.email,
        email_verified=excluded.email_verified,
        last_login_at=excluded.last_login_at
    `).run(
      String(issuer),
      String(subject),
      userId,
      email ? String(email) : null,
      emailVerified ? 1 : 0,
      at,
      at
    );
    return getOidcIdentity(issuer, subject);
  }

  function touchOidcIdentity(issuer, subject, { email = null, emailVerified = false } = {}) {
    db.prepare(`
      UPDATE oidc_identities
      SET email = ?, email_verified = ?, last_login_at = ?
      WHERE issuer = ? AND subject = ?
    `).run(
      email ? String(email) : null,
      emailVerified ? 1 : 0,
      nowIso(),
      String(issuer),
      String(subject)
    );
    return getOidcIdentity(issuer, subject);
  }

  function createSession(userId) {
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    const created = new Date();
    const expires = new Date(created.getTime() + 7 * 24 * 60 * 60 * 1000);
    db.prepare("INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(tokenHash, userId, created.toISOString(), expires.toISOString());
    return token;
  }

  function login(username, password) {
    const user = getUserByUsername(username);
    if (!user || !verifyPassword(password, user)) {
      throw Object.assign(new Error("invalid username or password"), { statusCode: 401 });
    }
    return { user, token: createSession(user.id) };
  }

  function getUserFromRequest(req) {
    const token = parseCookies(req)[COOKIE_NAME];
    if (!token) return null;
    const row = db.prepare(`
      SELECT u.* FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `).get(hashToken(token), nowIso());
    return row || null;
  }

  function requireUser(req) {
    const user = getUserFromRequest(req);
    if (!user) throw Object.assign(new Error("authentication required"), { statusCode: 401 });
    return user;
  }

  function logout(req) {
    const token = parseCookies(req)[COOKIE_NAME];
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
  }

  function publicUser(user) {
    return user ? {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      createdAt: user.created_at,
    } : null;
  }

  function seedDemoUsers() {
    const users = [
      ["alice", "Alice", "doscloud"],
      ["bob", "Bob", "doscloud"],
      ["carol", "Carol", "doscloud"],
      ["dave", "Dave", "doscloud"],
      ["erin", "Erin", "doscloud"],
    ];
    for (const [username, displayName, password] of users) {
      if (!getUserByUsername(username)) createUser({ username, displayName, password });
    }
  }

  function userDriveRoot(userId) {
    const root = path.join(usersRoot, userId, "C");
    fs.mkdirSync(root, { recursive: true });
    return root;
  }

  return {
    createUser,
    createExternalUser,
    createSession,
    login,
    logout,
    requireUser,
    getUserFromRequest,
    getUserById,
    getUserByUsername,
    getOidcIdentity,
    getOidcIdentityForUser,
    linkOidcIdentity,
    touchOidcIdentity,
    publicUser,
    seedDemoUsers,
    userDriveRoot,
    sessionCookie(token, maxAgeSeconds = 7 * 24 * 60 * 60) {
      return buildSessionCookie(token, maxAgeSeconds, secureCookies);
    },
    clearSessionCookie() {
      return buildSessionCookie("", 0, secureCookies);
    },
  };
}

module.exports = { createAuthService };
