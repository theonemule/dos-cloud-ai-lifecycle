const log = document.getElementById("log");
const fsTree = document.getElementById("fs-tree");
const rpcSummary = document.getElementById("rpc-summary");
const recentOps = document.getElementById("recent-ops");
const status = document.getElementById("status");

const writeLog = (msg) => {
  log.textContent += msg + "\n";
  log.scrollTop = log.scrollHeight;
};

const dosboxConf = [
  "[sdl]",
  "autolock=true",
  "",
  "[dosbox]",
  "machine=svga_s3",
  "memsize=16",
  "",
  "[cpu]",
  "core=auto",
  "cycles=12000",
  "",
  "[mixer]",
  "nosound=false",
  "",
  "[autoexec]",
  "@echo off",
  "mount c /remote",
  "c:",
  "echo REMOTE DOS DRIVE READY>C:\\REMOTEFS.TXT",
  "cd \\KEEN",
  "KEEN1.EXE",
  ""
].join("\n");

Dos(document.getElementById("dos"), {
  dosboxConf: dosboxConf,
  pathPrefix: "/emulators/",
  backend: "dosbox",
  backendLocked: true,
  workerThread: true,
  autoStart: true,
  autoSave: false,
  kiosk: false,
  imageRendering: "pixelated",
  renderAspect: "Fit",
  onEvent: (event, ci) => {
    if (event === "ci-ready") {
      window.__ci = ci; // smoke-test hook for this prototype
      status.textContent = "DOSBox is ready; loading Commander Keen from remote C:";
      (async () => {
        for (let i = 0; i < 40; i++) {
          try {
            const running = await ci.getRunningProgram();
            if (String(running || "").toUpperCase().startsWith("KEEN1")) {
              status.textContent = "Commander Keen is running from the server-hosted C: drive";
              status.classList.add("ok");
              return;
            }
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        status.textContent = "DOSBox is running; see the game window for startup status";
      })();
    }
  },
});

const proto = location.protocol === "https:" ? "wss:" : "ws:";
const drive = new RemoteDriveClient(proto + "//" + location.host + "/ws/fs?drive=demo");

async function refreshDrive() {
  try {
    await drive.connect();
    const root = await drive.list("C:\\");
    const keen = await drive.list("C:\\KEEN");
    const score = await drive.stat("C:\\KEEN\\SCORES.CK1");

    const lines = [
      "C:\\",
      ...root.map((e) => "  " + (e.directory ? "[DIR] " : "      ") + e.name),
      "",
      "C:\\KEEN\\",
      ...keen
        .filter((e) => /^(KEEN1\.EXE|SCORES\.CK1|CTLPANEL\.CK1|LEVEL0[1-3]\.CK1)$/i.test(e.name))
        .map((e) => "  " + e.name.padEnd(14) + " " + String(e.size).padStart(7) + " bytes"),
      "",
      "SCORES.CK1 modified: " + new Date(score.mtimeMs).toLocaleTimeString(),
    ];
    fsTree.textContent = lines.join("\n");
  } catch (e) {
    fsTree.textContent = (e.code || "ERR") + ": " + e.message;
  }
}

async function refreshStats() {
  try {
    const stats = await fetch("/api/stats?drive=demo", { cache: "no-store" }).then((r) => r.json());
    const ops = Object.entries(stats.ops || {})
      .sort((a, b) => b[1] - a[1])
      .map(([op, count]) => op + " " + count)
      .join("  ");

    rpcSummary.textContent =
      "RPCs " + (stats.requests || 0) +
      "   read " + (stats.bytesRead || 0) + " B" +
      "   written " + (stats.bytesWritten || 0) + " B\n" +
      (ops || "waiting for filesystem traffic...");

    recentOps.textContent = (stats.recent || [])
      .slice(0, 12)
      .map((x) => {
        const t = new Date(x.at).toLocaleTimeString();
        const bytes = x.bytes ? " " + x.bytes + " B" : "";
        return t + "  " + x.op.padEnd(8) + " " + (x.path || "C:\\") + bytes;
      })
      .join("\n");
  } catch (e) {
    rpcSummary.textContent = "metrics unavailable: " + e.message;
  }
}

drive.connect()
  .then(async () => {
    writeLog("Remote file service connected.");
    await refreshDrive();
  })
  .catch((e) => writeLog("Remote drive connection failed: " + e.message));

document.getElementById("refresh").onclick = refreshDrive;

document.getElementById("roundtrip").onclick = async () => {
  try {
    await drive.connect();
    const filePath = "C:\\REMOTEFS.TXT";
    const opened = await drive.open(filePath, "w+");
    const bytes = new TextEncoder().encode(
      "Written through the same WebSocket file service Commander Keen uses.\r\n" +
      new Date().toISOString() + "\r\n"
    );
    await drive.write(opened.handle, bytes);
    await drive.seek(opened.handle, 0, 0);
    const result = await drive.read(opened.handle, 4096);
    await drive.close(opened.handle);

    writeLog("Created " + filePath + " on the server-owned C: drive.");
    writeLog(new TextDecoder().decode(result.payload).trim());
    await refreshDrive();
    await refreshStats();
  } catch (e) {
    writeLog((e.code || "ERR") + ": " + e.message);
  }
};

setInterval(refreshStats, 1000);
setInterval(refreshDrive, 5000);
refreshStats();
