const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");
const rows = document.getElementById("rows");
const hero = document.getElementById("hero");
const toast = document.getElementById("toast");
const authError = document.getElementById("auth-error");

let currentUser = null;
let games = [];
let busy = new Set();
let authMethods = {
  local: { enabled: true, registrationEnabled: true },
  oidc: { enabled: false, providerName: "Single Sign-On", linkSupported: false },
};
let currentAuthState = { oidcLinked: false };

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: options.body ? { "content-type": "application/json", ...(options.headers || {}) } : options.headers,
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || ("Request failed: " + response.status));
  return data;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add("hidden"), 2500);
}

function configureAuthUi() {
  const oidcButton = document.getElementById("oidc-button");
  const divider = document.getElementById("auth-divider");
  const localSection = document.getElementById("local-auth-section");
  const registerDetails = document.getElementById("register-details");

  if (authMethods.oidc?.enabled) {
    oidcButton.textContent = "Continue with " + (authMethods.oidc.providerName || "Single Sign-On");
    oidcButton.classList.remove("hidden");
  } else {
    oidcButton.classList.add("hidden");
  }

  if (authMethods.local?.enabled) {
    localSection.classList.remove("hidden");
  } else {
    localSection.classList.add("hidden");
  }

  if (authMethods.local?.enabled && authMethods.local?.registrationEnabled) {
    registerDetails.classList.remove("hidden");
  } else {
    registerDetails.classList.add("hidden");
  }

  if (authMethods.oidc?.enabled && authMethods.local?.enabled) {
    divider.classList.remove("hidden");
  } else {
    divider.classList.add("hidden");
  }
}

function updateLinkButton() {
  const button = document.getElementById("link-oidc-button");
  const shouldShow =
    Boolean(currentUser) &&
    Boolean(authMethods.oidc?.enabled) &&
    Boolean(authMethods.oidc?.linkSupported) &&
    !currentAuthState.oidcLinked;

  button.textContent = "Link " + (authMethods.oidc?.providerName || "SSO");
  button.classList.toggle("hidden", !shouldShow);
}

function showLogin() {
  currentUser = null;
  currentAuthState = { oidcLinked: false };
  appView.classList.add("hidden");
  loginView.classList.remove("hidden");
  configureAuthUi();
}

function showApp(user, authState = currentAuthState) {
  currentUser = user;
  currentAuthState = authState || { oidcLinked: false };
  loginView.classList.add("hidden");
  appView.classList.remove("hidden");
  document.getElementById("user-name").textContent = user.displayName;
  updateLinkButton();
  loadCatalog();
}

async function refreshAuthState() {
  const result = await api("/api/auth/me");
  currentAuthState = result.auth || { oidcLinked: false };
  updateLinkButton();
  return result;
}

async function boot() {
  authMethods = await api("/api/auth/methods");
  configureAuthUi();
  const result = await api("/api/auth/me");
  if (result.user) showApp(result.user, result.auth);
  else showLogin();
}

async function loadCatalog() {
  const data = await api("/api/catalog");
  games = data.games;
  render();
}

function gameCard(game) {
  const card = document.createElement("article");
  card.className = "game-card";
  card.dataset.game = game.id;

  const poster = document.createElement("div");
  poster.className = "poster";
  poster.style.setProperty("--accent", game.accent);
  poster.innerHTML =
    (game.screenshot
      ? '<img src="' + escapeHtml(game.screenshot) + '" alt="' + escapeHtml(game.title) + ' screenshot" loading="lazy">'
      : '<div class="poster-grid"></div><div class="glyph">' + escapeHtml(game.glyph) + '</div>') +
    '<div class="poster-year">' + (game.year || "") + '</div>';

  const body = document.createElement("div");
  body.className = "card-body";
  body.innerHTML =
    '<h3>' + escapeHtml(game.title) + '</h3>' +
    '<p class="subtitle">' + escapeHtml(game.subtitle || game.publisher) + '</p>' +
    '<div class="badges"><span class="badge shareware">Shareware</span>' +
    (game.multiplayer?.enabled ? '<span class="badge ipx">IPX Multiplayer</span>' : '') + '</div>' +
    '<p class="description">' + escapeHtml(game.description) + '</p>';

  const actions = document.createElement("div");
  actions.className = "card-actions";
  const action = document.createElement("button");
  action.className = game.installed ? "primary play" : "install";
  action.disabled = busy.has(game.id);
  action.textContent = busy.has(game.id) ? "Working…" : game.installed ? "▶ Play" : "＋ Install";
  action.onclick = () => game.installed ? playGame(game) : installGame(game);
  actions.appendChild(action);

  if (game.installed && game.multiplayer?.enabled) {
    const multiplayer = document.createElement("button");
    multiplayer.className = "multiplayer";
    multiplayer.textContent = "⌁ Multiplayer";
    multiplayer.onclick = () => hostMultiplayer(game);
    actions.appendChild(multiplayer);
  }

  if (game.installed) {
    const uninstall = document.createElement("button");
    uninstall.className = "icon-button";
    uninstall.title = "Uninstall";
    uninstall.textContent = "⋯";
    uninstall.onclick = () => uninstallGame(game);
    actions.appendChild(uninstall);
  }

  body.appendChild(actions);
  card.append(poster, body);
  return card;
}

function renderRow(title, items, note = "") {
  if (!items.length) return;
  const section = document.createElement("section");
  section.className = "catalog-row";
  section.innerHTML = '<div class="row-heading"><h2>' + escapeHtml(title) + '</h2><span>' + escapeHtml(note) + '</span></div>';
  const rail = document.createElement("div");
  rail.className = "card-rail";
  items.forEach(game => rail.appendChild(gameCard(game)));
  section.appendChild(rail);
  rows.appendChild(section);
}

function render() {
  rows.innerHTML = "";
  const installed = games.filter(g => g.installed).sort((a,b) => (b.lastPlayedAt || "").localeCompare(a.lastPlayedAt || ""));
  const featured = games.filter(g => g.featured);


  const lead = installed[0] || featured[0] || games[0];
  if (lead) {
    hero.style.setProperty("--hero-accent", lead.accent);
    hero.innerHTML =
      '<div class="hero-copy">' +
      '<span class="kicker">' + (lead.installed ? "READY TO PLAY" : "FEATURED SHAREWARE") + '</span>' +
      '<h1>' + escapeHtml(lead.title) + '</h1>' +
      '<h3>' + escapeHtml(lead.subtitle || "") + '</h3>' +
      '<p>' + escapeHtml(lead.description) + '</p>' +
      '<div id="hero-actions"></div>' +
      '</div>' +
      (lead.screenshot
        ? '<img class="hero-image" src="' + escapeHtml(lead.screenshot) + '" alt="' + escapeHtml(lead.title) + ' screenshot">'
        : '<div class="hero-mark">' + escapeHtml(lead.glyph) + '</div>');
    const actions = hero.querySelector("#hero-actions");
    const button = document.createElement("button");
    button.className = "primary hero-action";
    button.textContent = lead.installed ? "▶ Play" : "＋ Install";
    button.onclick = () => lead.installed ? playGame(lead) : installGame(lead);
    actions.appendChild(button);
    if (lead.installed && lead.multiplayer?.enabled) {
      const multiplayer = document.createElement("button");
      multiplayer.className = "hero-action";
      multiplayer.textContent = "⌁ Multiplayer";
      multiplayer.onclick = () => hostMultiplayer(lead);
      actions.appendChild(multiplayer);
    }
  }

  renderRow("Your Library", installed, installed.length ? installed.length + " installed" : "");
  renderRow("Featured", featured);
  renderRow("Browse All", games);
}

async function installGame(game) {
  busy.add(game.id);
  render();
  try {
    await api("/api/library/" + game.id + "/install", { method: "POST" });
    showToast(game.title + " installed into your C: drive");
    await loadCatalog();
  } catch (err) {
    showToast(err.message);
  } finally {
    busy.delete(game.id);
    render();
  }
}

async function uninstallGame(game) {
  if (!confirm("Remove " + game.title + " from your DOS drive? Saved files inside its game folder will also be removed.")) return;
  busy.add(game.id);
  render();
  try {
    await api("/api/library/" + game.id, { method: "DELETE" });
    showToast(game.title + " uninstalled");
    await loadCatalog();
  } catch (err) {
    showToast(err.message);
  } finally {
    busy.delete(game.id);
    render();
  }
}

async function playGame(game) {
  try {
    const data = await api("/api/library/" + game.id + "/launch", { method: "POST" });
    window.open("/runtime.html?session=" + encodeURIComponent(data.session.id), "_blank", "noopener");
    setTimeout(loadCatalog, 500);
  } catch (err) {
    showToast(err.message);
  }
}

async function openConsole() {
  try {
    const data = await api("/api/console/launch", { method: "POST" });
    window.open("/runtime.html?session=" + encodeURIComponent(data.session.id), "_blank", "noopener");
  } catch (err) {
    showToast(err.message);
  }
}

async function hostMultiplayer(game) {
  const maxPlayers = Number(game.multiplayer?.maxPlayers || 2);
  const answer = prompt("How many players? (2-" + maxPlayers + ")", "2");
  if (answer == null) return;
  const players = Number(answer);
  if (!Number.isInteger(players) || players < 2 || players > maxPlayers) {
    showToast("Choose between 2 and " + maxPlayers + " players");
    return;
  }
  try {
    const data = await api("/api/multiplayer/host", {
      method: "POST",
      body: JSON.stringify({ gameId: game.id, players }),
    });
    showToast("IPX room " + data.room.code + " created. Share that code with the other players.");
    window.open("/runtime.html?session=" + encodeURIComponent(data.session.id), "_blank", "noopener");
  } catch (err) {
    showToast(err.message);
  }
}

async function joinMultiplayer() {
  const answer = prompt("Enter the multiplayer join code");
  if (answer == null) return;
  const code = String(answer).trim().toUpperCase();
  if (!code) return;
  try {
    const data = await api("/api/multiplayer/join", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    showToast("Joining IPX room " + data.room.code);
    window.open("/runtime.html?session=" + encodeURIComponent(data.session.id), "_blank", "noopener");
    setTimeout(loadCatalog, 500);
  } catch (err) {
    showToast(err.message);
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

document.getElementById("login-form").addEventListener("submit", async event => {
  event.preventDefault();
  authError.textContent = "";
  try {
    const result = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: document.getElementById("username").value,
        password: document.getElementById("password").value,
      }),
    });
    currentAuthState = { oidcLinked: false };
    showApp(result.user, currentAuthState);
    await refreshAuthState();
  } catch (err) {
    authError.textContent = err.message;
  }
});

document.getElementById("register-form").addEventListener("submit", async event => {
  event.preventDefault();
  authError.textContent = "";
  try {
    const result = await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        username: document.getElementById("register-username").value,
        displayName: document.getElementById("register-name").value,
        password: document.getElementById("register-password").value,
      }),
    });
    currentAuthState = { oidcLinked: false };
    showApp(result.user, currentAuthState);
    await refreshAuthState();
  } catch (err) {
    authError.textContent = err.message;
  }
});

document.getElementById("oidc-button").onclick = () => {
  window.location.assign("/api/auth/oidc/start");
};

document.getElementById("link-oidc-button").onclick = async () => {
  try {
    const result = await api("/api/auth/oidc/link/start", { method: "POST" });
    window.location.assign(result.url);
  } catch (err) {
    showToast(err.message);
  }
};

document.getElementById("logout-button").onclick = async () => {
  await api("/api/auth/logout", { method: "POST" });
  showLogin();
};
document.getElementById("console-button").onclick = openConsole;
document.getElementById("join-multiplayer-button").onclick = joinMultiplayer;
document.getElementById("home-button").onclick = () => window.scrollTo({ top: 0, behavior: "smooth" });

boot().catch(err => {
  authError.textContent = err.message;
  showLogin();
});
