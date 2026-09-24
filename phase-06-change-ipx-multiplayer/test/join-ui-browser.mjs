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

async function loginAndInstall(context, username) {
  const page = await context.newPage();
  await page.goto(base, { waitUntil: "domcontentloaded" });

  const login = await page.evaluate(async name => {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: name, password: "doscloud" }),
    });
    return response.status;
  }, username);
  assert(login === 200, "login failed for " + username);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#join-multiplayer-button").waitFor({ state: "visible" });

  const install = await page.evaluate(async () => {
    const response = await fetch("/api/library/doom/install", { method: "POST" });
    return { status: response.status, body: await response.json() };
  });
  assert(install.status === 200, "DOOM install failed: " + JSON.stringify(install.body));

  return page;
}

const hostContext = await browser.newContext({ viewport: { width: 1100, height: 760 } });
const joinContext = await browser.newContext({ viewport: { width: 1100, height: 760 } });

try {
  // Deliberately use the same account in both contexts. This reproduces the
  // incognito/same-user testing flow that previously returned HTTP 409.
  const hostPage = await loginAndInstall(hostContext, "alice");
  const joinPage = await loginAndInstall(joinContext, "alice");

  const hosted = await hostPage.evaluate(async () => {
    const response = await fetch("/api/multiplayer/host", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId: "doom", players: 2 }),
    });
    return { status: response.status, body: await response.json() };
  });
  assert(hosted.status === 201, "host room failed: " + JSON.stringify(hosted.body));

  await joinPage.locator("#join-multiplayer-button").click();
  await joinPage.locator("#join-multiplayer-modal").waitFor({ state: "visible" });
  assert(
    (await joinPage.locator("#join-multiplayer-title").textContent())?.includes("Join a multiplayer game"),
    "join modal title is not clear"
  );

  await joinPage.locator("#join-multiplayer-code").fill(hosted.body.room.code.toLowerCase());

  // Capture the requested runtime URL instead of depending on popup semantics.
  await joinPage.evaluate(() => {
    window.__dosCloudOpenedRuntime = null;
    window.open = url => {
      window.__dosCloudOpenedRuntime = String(url);
      return null;
    };
  });

  await joinPage.locator("#join-multiplayer-submit").click();
  await joinPage.waitForFunction(() => Boolean(window.__dosCloudOpenedRuntime), null, { timeout: 10000 });

  const runtimeUrl = await joinPage.evaluate(() => window.__dosCloudOpenedRuntime);
  const sessionId = new URL(runtimeUrl, base).searchParams.get("session");
  assert(sessionId, "join UI did not create a runtime launch");

  const launch = await joinPage.evaluate(async id => {
    const response = await fetch("/api/launch/" + encodeURIComponent(id));
    return { status: response.status, body: await response.json() };
  }, sessionId);

  assert(launch.status === 200, "joined launch lookup failed: " + JSON.stringify(launch.body));
  assert(launch.body.launch.multiplayer.role === "client", "join UI did not create a client role");
  assert(launch.body.launch.multiplayer.code === hosted.body.room.code, "join UI used the wrong room");

  console.log(JSON.stringify({
    result: "PASS",
    sameAccount: true,
    roomCode: hosted.body.room.code,
    joinUiVisible: true,
    role: launch.body.launch.multiplayer.role,
  }, null, 2));
} finally {
  await hostContext.close().catch(() => {});
  await joinContext.close().catch(() => {});
  await browser.close().catch(() => {});
}
