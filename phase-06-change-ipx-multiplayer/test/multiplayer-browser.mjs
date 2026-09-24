import { chromium } from "playwright-core";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { createAppServer } = require("../server.js");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let ownedApp = null;
let ownedStateRoot = null;
let base = process.env.TEST_URL || "";

if (!base) {
  ownedStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dos-cloud-phase6-multiplayer-browser-"));
  ownedApp = await createAppServer({
    port: 0,
    stateRoot: ownedStateRoot,
    seedDemoUsers: true,
  });
  const address = await ownedApp.listen();
  base = "http://127.0.0.1:" + address.port + "/";
}

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

async function makePlayer(username) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  const page = await context.newPage();
  await page.goto(base, { waitUntil: "domcontentloaded" });

  const login = await page.evaluate(async name => {
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: name, password: "doscloud" }),
    });
    return r.status;
  }, username);
  assert(login === 200, "login failed for " + username);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#join-multiplayer-button").waitFor({ state: "visible" });

  const install = await page.evaluate(async () => {
    const r = await fetch("/api/library/doom/install", { method: "POST" });
    return { status: r.status, body: await r.json() };
  });
  assert(install.status === 200, "DOOM install failed for " + username + ": " + JSON.stringify(install.body));
  return { username, context, page };
}

async function runningProgram(page) {
  return String(await page.evaluate(async () => {
    try {
      return await Promise.race([
        window.__ci?.getRunningProgram?.(),
        new Promise(resolve => setTimeout(() => resolve(""), 1500)),
      ]);
    } catch {
      return "";
    }
  }) || "");
}

let host;
let client;
try {
  host = await makePlayer("alice");
  client = await makePlayer("bob");

  const hosted = await host.page.evaluate(async () => {
    const r = await fetch("/api/multiplayer/host", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId: "doom", players: 2 }),
    });
    return { status: r.status, body: await r.json() };
  });
  assert(hosted.status === 201, "host room failed: " + JSON.stringify(hosted.body));

  // Reproduce the real user flow: host opens the runtime before anyone has joined.
  const hostRuntime = await host.context.newPage();
  const hostErrors = [];
  hostRuntime.on("pageerror", err => hostErrors.push(err.message));
  await hostRuntime.goto(
    new URL("/runtime.html?session=" + encodeURIComponent(hosted.body.session.id), base).href,
    { waitUntil: "domcontentloaded" }
  );
  await hostRuntime.waitForFunction(() => !!window.__ipxNet, null, { timeout: 15000 });
  await hostRuntime.waitForFunction(() => window.__dosCloudWaitingForPlayers === true, null, { timeout: 10000 });

  // The regression: before the second player arrives, DOS/IPXSETUP must not start.
  await new Promise(resolve => setTimeout(resolve, 2500));
  const hostStartedEarly = await hostRuntime.evaluate(() => Boolean(window.__ci));
  const waitingText = await hostRuntime.locator("#runtime-status").textContent();
  assert(!hostStartedEarly, "host DOSBox started before the room was full");
  assert(waitingText?.includes("Waiting for 2 players"), "host does not show an intelligible waiting state");

  // Join through the real visible UI.
  await client.page.locator("#join-multiplayer-button").click();
  await client.page.locator("#join-multiplayer-modal").waitFor({ state: "visible" });
  assert(
    (await client.page.locator("#join-multiplayer-title").textContent())?.includes("Join a multiplayer game"),
    "join multiplayer modal title is not clear"
  );
  await client.page.locator("#join-multiplayer-code").fill(hosted.body.room.code.toLowerCase());

  await client.page.evaluate(() => {
    window.__dosCloudOpenedRuntime = null;
    window.open = url => {
      window.__dosCloudOpenedRuntime = String(url);
      return null;
    };
  });

  await client.page.locator("#join-multiplayer-submit").click();
  await client.page.waitForFunction(() => Boolean(window.__dosCloudOpenedRuntime), null, { timeout: 10000 });
  const openedRuntimeUrl = await client.page.evaluate(() => window.__dosCloudOpenedRuntime);
  const clientRuntimeUrl = new URL(openedRuntimeUrl, base);
  const clientSessionId = clientRuntimeUrl.searchParams.get("session");
  assert(clientSessionId, "join UI did not create a runtime session");

  const clientLaunch = await client.page.evaluate(async sessionId => {
    const r = await fetch("/api/launch/" + encodeURIComponent(sessionId));
    return { status: r.status, body: await r.json() };
  }, clientSessionId);
  assert(clientLaunch.status === 200, "join UI launch lookup failed: " + JSON.stringify(clientLaunch.body));
  assert(clientLaunch.body.launch.multiplayer.code === hosted.body.room.code, "join UI used the wrong room code");
  assert(clientLaunch.body.launch.multiplayer.role === "client", "join UI did not create a client launch");

  const clientRuntime = await client.context.newPage();
  const clientErrors = [];
  clientRuntime.on("pageerror", err => clientErrors.push(err.message));
  await clientRuntime.goto(clientRuntimeUrl.href, { waitUntil: "domcontentloaded" });

  // Room-ready releases both browsers into DOSBox startup.
  await hostRuntime.waitForFunction(() => window.__dosCloudWaitingForPlayers === false, null, { timeout: 15000 });
  await hostRuntime.waitForFunction(() => !!window.__ci, null, { timeout: 30000 });
  await clientRuntime.waitForFunction(() => !!window.__ipxNet, null, { timeout: 15000 });
  await clientRuntime.waitForFunction(() => !!window.__ci, null, { timeout: 30000 });

  await hostRuntime.waitForFunction(() => window.__ipxNet?.connected?.has(2), null, { timeout: 15000 });
  await clientRuntime.waitForFunction(() => window.__ipxNet?.connected?.has(1), null, { timeout: 15000 });

  let hostProgram = "";
  let clientProgram = "";
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    hostProgram = await runningProgram(hostRuntime);
    clientProgram = await runningProgram(clientRuntime);
    if (hostProgram.toUpperCase().includes("DOOM") && clientProgram.toUpperCase().includes("DOOM")) break;
    await new Promise(resolve => setTimeout(resolve, 750));
  }

  const hostStatus = await hostRuntime.locator("#runtime-status").textContent();
  const clientStatus = await clientRuntime.locator("#runtime-status").textContent();
  const hostCode = await hostRuntime.locator(".room-code").textContent();
  const clientCode = await clientRuntime.locator(".room-code").textContent();

  console.log(JSON.stringify({
    roomCode: hosted.body.room.code,
    hostWaitedForClient: true,
    host: { program: hostProgram, status: hostStatus, code: hostCode, errors: hostErrors },
    client: { program: clientProgram, status: clientStatus, code: clientCode, errors: clientErrors },
    ipxConnected: true,
    joinedThroughVisibleUi: true,
  }, null, 2));

  assert(hostCode === hosted.body.room.code && clientCode === hosted.body.room.code, "runtime room code mismatch");
  assert(hostErrors.length === 0, "host runtime errors: " + hostErrors.join(" | "));
  assert(clientErrors.length === 0, "client runtime errors: " + clientErrors.join(" | "));
  assert(hostProgram.toUpperCase().includes("DOOM"), "host did not reach DOOM; running=" + hostProgram);
  assert(clientProgram.toUpperCase().includes("DOOM"), "client did not reach DOOM; running=" + clientProgram);
} finally {
  if (host) await host.context.close();
  if (client) await client.context.close();
  await browser.close();
  if (ownedApp) await ownedApp.close();
  if (ownedStateRoot) fs.rmSync(ownedStateRoot, { recursive: true, force: true });
}
