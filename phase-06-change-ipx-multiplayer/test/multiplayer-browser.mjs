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

async function netStats(page) {
  return page.evaluate(async () => {
    const stats = await Promise.race([
      window.__ci?.asyncifyStats?.(),
      new Promise(resolve => setTimeout(() => resolve(null), 1500)),
    ]);
    return { sent: Number(stats?.netSent || 0), recv: Number(stats?.netRecv || 0) };
  });
}

function watchEmulator(page, errors) {
  page.on("pageerror", err => errors.push(err.message || String(err)));
  page.on("console", message => {
    const text = message.text();
    if (/mistmatch|\[panic\]|Backend crashed|RuntimeError: unreachable/i.test(text)) errors.push(text);
  });
}

const isDoom = program => /^DOOM(\.EXE)?$/i.test(String(program).trim());

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
  watchEmulator(hostRuntime, hostErrors);
  await hostRuntime.goto(
    new URL("/runtime.html?session=" + encodeURIComponent(hosted.body.session.id), base).href,
    { waitUntil: "domcontentloaded" }
  );
  await hostRuntime.waitForFunction(() => !!window.__ipxNet, null, { timeout: 15000 });

  // The host boots straight away (no waiting for the room to fill) and announces its
  // IPX server once DOSBox-X's own loopback client has registered with it.
  await hostRuntime.waitForFunction(() => !!window.__ci, null, { timeout: 30000 });
  await hostRuntime.waitForFunction(() => window.__ipxNet?.localServerReady === true, null, { timeout: 15000 });

  // Regression: the host selects the join code and presses Ctrl+C to copy it while
  // IPXSETUP is waiting. That keystroke must stay in the page; if it reaches DOS it
  // sits in the keyboard buffer and aborts IPXSETUP (^C) when the guest arrives.
  await hostRuntime.click(".room-code");
  assert(await hostRuntime.evaluate(() => window.__dosCloudKeyboardOwner()) === "page",
    "clicking the side panel did not return the keyboard to the page");
  await hostRuntime.keyboard.press("Control+c");

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
  watchEmulator(clientRuntime, clientErrors);
  await clientRuntime.goto(clientRuntimeUrl.href, { waitUntil: "domcontentloaded" });

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
    if (isDoom(hostProgram) && isDoom(clientProgram)) break;
    await new Promise(resolve => setTimeout(resolve, 750));
  }

  // Prove IPX traffic is actually flowing through the relay in both directions,
  // not just that the processes started.
  const hostBefore = await netStats(hostRuntime);
  const clientBefore = await netStats(clientRuntime);
  await new Promise(resolve => setTimeout(resolve, 5000));
  const hostAfter = await netStats(hostRuntime);
  const clientAfter = await netStats(clientRuntime);
  const traffic = {
    hostToClientBytes: hostAfter.sent - hostBefore.sent,
    clientToHostBytes: clientAfter.sent - clientBefore.sent,
    hostReceivedBytes: hostAfter.recv - hostBefore.recv,
    clientReceivedBytes: clientAfter.recv - clientBefore.recv,
  };

  const hostStatus = await hostRuntime.locator("#runtime-status").textContent();
  const clientStatus = await clientRuntime.locator("#runtime-status").textContent();
  const hostCode = await hostRuntime.locator(".room-code").textContent();
  const clientCode = await clientRuntime.locator(".room-code").textContent();

  console.log(JSON.stringify({
    roomCode: hosted.body.room.code,
    hostBootedBeforeClientJoined: true,
    traffic,
    host: { program: hostProgram, status: hostStatus, code: hostCode, errors: hostErrors },
    client: { program: clientProgram, status: clientStatus, code: clientCode, errors: clientErrors },
    ipxConnected: true,
    joinedThroughVisibleUi: true,
  }, null, 2));

  assert(hostCode === hosted.body.room.code && clientCode === hosted.body.room.code, "runtime room code mismatch");
  assert(hostErrors.length === 0, "host runtime errors: " + hostErrors.join(" | "));
  assert(clientErrors.length === 0, "client runtime errors: " + clientErrors.join(" | "));
  assert(isDoom(hostProgram), "host did not reach DOOM; running=" + hostProgram);
  assert(isDoom(clientProgram), "client did not reach DOOM; running=" + clientProgram);
  for (const [name, bytes] of Object.entries(traffic)) {
    assert(bytes > 1000, "IPX traffic stalled (" + name + "=" + bytes + ")");
  }
} finally {
  if (host) await host.context.close();
  if (client) await client.context.close();
  await browser.close();
  if (ownedApp) await ownedApp.close();
  if (ownedStateRoot) fs.rmSync(ownedStateRoot, { recursive: true, force: true });
}
