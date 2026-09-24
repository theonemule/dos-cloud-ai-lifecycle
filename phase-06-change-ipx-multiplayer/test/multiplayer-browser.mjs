import { chromium } from "playwright-core";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const base = process.env.TEST_URL || "http://127.0.0.1:8080/";
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
  const install = await page.evaluate(async () => {
    const r = await fetch("/api/library/doom/install", { method: "POST" });
    return { status: r.status, body: await r.json() };
  });
  assert(install.status === 200, "DOOM install failed for " + username + ": " + JSON.stringify(install.body));
  return { username, context, page };
}

async function runningProgram(page) {
  return String(await page.evaluate(async () => {
    try { return await window.__ci?.getRunningProgram?.(); } catch { return ""; }
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

  const joined = await client.page.evaluate(async code => {
    const r = await fetch("/api/multiplayer/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    return { status: r.status, body: await r.json() };
  }, hosted.body.room.code);
  assert(joined.status === 201, "join room failed: " + JSON.stringify(joined.body));

  const hostRuntime = await host.context.newPage();
  const clientRuntime = await client.context.newPage();
  const hostErrors = [];
  const clientErrors = [];
  hostRuntime.on("pageerror", err => hostErrors.push(err.message));
  clientRuntime.on("pageerror", err => clientErrors.push(err.message));

  await hostRuntime.goto(new URL("/runtime.html?session=" + encodeURIComponent(hosted.body.session.id), base).href, { waitUntil: "domcontentloaded" });
  await hostRuntime.waitForFunction(() => !!window.__ipxNet, null, { timeout: 15000 });
  await hostRuntime.waitForFunction(() => !!window.__ci, null, { timeout: 25000 });

  await clientRuntime.goto(new URL("/runtime.html?session=" + encodeURIComponent(joined.body.session.id), base).href, { waitUntil: "domcontentloaded" });
  await clientRuntime.waitForFunction(() => !!window.__ipxNet, null, { timeout: 15000 });
  await clientRuntime.waitForFunction(() => !!window.__ci, null, { timeout: 25000 });

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
    host: { program: hostProgram, status: hostStatus, code: hostCode, errors: hostErrors },
    client: { program: clientProgram, status: clientStatus, code: clientCode, errors: clientErrors },
    ipxConnected: true,
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
}
