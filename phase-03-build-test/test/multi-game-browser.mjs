import { chromium } from "playwright-core";

const base = process.env.TEST_URL || "http://127.0.0.1:8080/";
const cases = [
  { user: "alice", game: "keen1", expected: "KEEN" },
  { user: "alice", game: "doom", expected: "DOOM" },
  { user: "bob", game: "wolf3d", expected: "WOLF" },
  { user: "carol", game: "duke3d", expected: "DUKE" },
];

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

async function runCase(item) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  try {
    const page = await context.newPage();
    await page.goto(base, { waitUntil: "domcontentloaded" });
    const login = await page.evaluate(async ({ user }) => {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: user, password: "doscloud" }),
      });
      return r.status;
    }, item);
    if (login !== 200) throw new Error("login failed for " + item.user);

    const installed = await page.evaluate(async ({ game }) => {
      const r = await fetch("/api/library/" + game + "/install", { method: "POST" });
      return { status: r.status, body: await r.json() };
    }, item);
    if (installed.status !== 200) throw new Error("install failed for " + item.game + ": " + JSON.stringify(installed.body));

    const launched = await page.evaluate(async ({ game }) => {
      const r = await fetch("/api/library/" + game + "/launch", { method: "POST" });
      return { status: r.status, body: await r.json() };
    }, item);
    if (launched.status !== 201) throw new Error("launch failed for " + item.game);

    const runtime = await context.newPage();
    await runtime.goto(new URL("/runtime.html?session=" + encodeURIComponent(launched.body.session.id), base).href, { waitUntil: "domcontentloaded" });
    await runtime.waitForFunction(() => !!window.__ci, null, { timeout: 20000 });
    await runtime.waitForTimeout(25000);

    const running = String(await runtime.evaluate(async () => {
      try { return await window.__ci.getRunningProgram(); } catch { return ""; }
    }) || "");
    const title = await runtime.locator("#runtime-title").textContent();
    const bodyText = await runtime.locator("body").innerText();
    return { ...item, title, runningProgram: running, crashed: /backend crashed|memory access out of bounds/i.test(bodyText), matched: running.toUpperCase().includes(item.expected) };
  } finally {
    await context.close();
  }
}

try {
  const results = await Promise.all(cases.map(runCase));
  console.log(JSON.stringify(results, null, 2));
  if (results.some(r => !r.matched || r.crashed)) process.exitCode = 1;
} finally {
  await browser.close();
}
