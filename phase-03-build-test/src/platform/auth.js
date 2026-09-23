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

function sessionCookie(token, maxAgeSeconds = 7 * 24 * 60 * 60) {
  return [
    COOKIE_NAME + "=" + encodeURIComponent(token),
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=" + maxAgeSeconds
  ].join("; ");
}

function clearSessionCookie() {
  return COOKIE_NAME + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
}

function createAuthService({ db, usersRoot }) {
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
    if (String(password).length < 6) {
      throw Object.assign(new Error("password must be at least 6 characters"), { statusCode: 400 });
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
    `).run(id, username, String(displayName || username).trim(), creds.hash, creds.salt, createdAt);

    const root = path.join(usersRoot, id, "C");
    fs.mkdirSync(path.join(root, "GAMES"), { recursive: true });
    fs.mkdirSync(path.join(root, "USER"), { recursive: true });
    fs.mkdirSync(path.join(root, "DOCS"), { recursive: true });

    return getUserById(id);
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
    login,
    logout,
    requireUser,
    getUserFromRequest,
    getUserById,
    getUserByUsername,
    publicUser,
    seedDemoUsers,
    userDriveRoot,
    sessionCookie,
    clearSessionCookie,
  };
}

module.exports = { createAuthService };
