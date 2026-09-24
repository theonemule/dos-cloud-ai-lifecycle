const title = document.getElementById("runtime-title");
const subtitle = document.getElementById("runtime-subtitle");
const status = document.getElementById("runtime-status");
const controls = document.getElementById("controls");
const modeLabel = document.getElementById("mode-label");

function showMultiplayerDetails(multiplayer) {
  const panel = document.createElement("section");
  panel.className = "multiplayer-panel";

  const heading = document.createElement("h3");
  heading.textContent = multiplayer.role === "host" ? "Hosting IPX Multiplayer" : "Joined IPX Multiplayer";

  const codeLabel = document.createElement("div");
  codeLabel.className = "room-code-label";
  codeLabel.textContent = "Join code";

  const code = document.createElement("div");
  code.className = "room-code";
  code.textContent = multiplayer.code;

  const players = document.createElement("p");
  players.textContent = "Players: " + multiplayer.expectedPlayers + " · IPX over WebSocket";

  const instructions = document.createElement("p");
  instructions.textContent = multiplayer.instructions || "Keep this window open while the multiplayer game is active.";

  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copy join code";
  copy.onclick = async () => {
    await navigator.clipboard.writeText(multiplayer.code);
    copy.textContent = "Copied";
    setTimeout(() => { copy.textContent = "Copy join code"; }, 1400);
  };

  panel.append(heading, codeLabel, code, players, instructions, copy);
  controls.before(panel);
}

async function load() {
  const sessionId = new URLSearchParams(location.search).get("session");
  if (!sessionId) throw new Error("Missing launch session");

  const response = await fetch("/api/launch/" + encodeURIComponent(sessionId), { credentials: "same-origin" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Unable to load launch session");

  const config = data.launch;
  title.textContent = config.title;
  subtitle.textContent = config.subtitle || (config.mode === "console" ? "Your personal DOS environment" : "");
  document.title = config.title + " · DOS Cloud";
  modeLabel.textContent = config.multiplayer
    ? "Multiplayer Game Session"
    : config.mode === "console" ? "DOS Console" : "Game Session";

  if (config.multiplayer) showMultiplayerDetails(config.multiplayer);

  if (config.controls?.length) {
    controls.innerHTML = "<h3>Controls</h3>" + config.controls.map(c =>
      '<div class="control"><kbd>' + c.key + '</kbd><span>' + c.action + '</span></div>'
    ).join("");
  }

  let ipxNet = null;
  if (config.multiplayer) {
    status.textContent = config.multiplayer.role === "host"
      ? "Opening IPX room " + config.multiplayer.code + "…"
      : "Joining IPX room " + config.multiplayer.code + "…";
    ipxNet = await window.createIpxWebSocketNet(config.multiplayer, sessionId);
    window.__ipxNet = ipxNet;
  }

  const d = config.dosbox || {};
  const dosboxConf = [
    "[sdl]",
    "autolock=true",
    "",
    "[dosbox]",
    "machine=" + (d.machine || "svga_s3"),
    "memsize=" + (d.memoryMb || 16),
    "",
    "[cpu]",
    "core=auto",
    "cycles=" + (d.cycles || "auto"),
    "",
    "[mixer]",
    "nosound=false",
    "",
    "[autoexec]",
    "@echo off",
    ...config.autoexec,
    ""
  ].join("\n");

  const dosOptions = {
    dosboxConf,
    pathPrefix: "/emulators/",
    backend: "dosboxX",
    backendLocked: true,
    backendHardware: false,
    renderBackend: "canvas",
    workerThread: true,
    autoStart: true,
    autoSave: false,
    kiosk: false,
    imageRendering: "pixelated",
    renderAspect: "4/3",
    onEvent: (event, ci) => {
      if (event === "ci-ready") {
        window.__ci = ci;
        status.textContent = config.multiplayer
          ? "IPX room " + config.multiplayer.code + " · " + config.multiplayer.role
          : config.mode === "console" ? "DOS console ready" : "Game runtime ready";
        status.classList.add("ok");
      }
    }
  };

  if (ipxNet) {
    dosOptions.sharedNet = ipxNet;
    if (config.multiplayer.role === "host") {
      dosOptions.startIpxServer = true;
    } else {
      dosOptions.connectIpxAddress = "host";
    }
  }

  Dos(document.getElementById("dos"), dosOptions);
}

window.addEventListener("doscloud-ipx-status", event => {
  const detail = event.detail || {};
  if (detail.state === "peer-joined") {
    status.textContent = "IPX peer connected";
    status.classList.add("ok");
  } else if (detail.state === "peer-left") {
    status.textContent = "IPX peer disconnected";
  } else if (detail.state === "disconnected") {
    status.textContent = "IPX relay disconnected";
    status.classList.remove("ok");
    status.classList.add("error");
  }
});

load().catch(err => {
  status.textContent = err.message;
  status.classList.add("error");
  title.textContent = "Unable to start DOS";
});
