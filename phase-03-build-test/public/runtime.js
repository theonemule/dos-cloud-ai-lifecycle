const title = document.getElementById("runtime-title");
const subtitle = document.getElementById("runtime-subtitle");
const status = document.getElementById("runtime-status");
const controls = document.getElementById("controls");
const modeLabel = document.getElementById("mode-label");

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
  modeLabel.textContent = config.mode === "console" ? "DOS Console" : "Game Session";

  if (config.controls?.length) {
    controls.innerHTML = "<h3>Controls</h3>" + config.controls.map(c =>
      '<div class="control"><kbd>' + c.key + '</kbd><span>' + c.action + '</span></div>'
    ).join("");
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

  Dos(document.getElementById("dos"), {
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
        status.textContent = config.mode === "console" ? "DOS console ready" : "Game runtime ready";
        status.classList.add("ok");
      }
    }
  });
}

load().catch(err => {
  status.textContent = err.message;
  status.classList.add("error");
  title.textContent = "Unable to start DOS";
});
