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

try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, ignoreHTTPSErrors: process.env.TEST_IGNORE_HTTPS_ERRORS === "true" });
  const page = await context.newPage();
  const fatal = [];
  page.on("pageerror", err => fatal.push(err.message));

  await page.goto(base, { waitUntil: "domcontentloaded" });
  assert(await page.locator("#demo-buttons").count() === 0, "demo user shortcuts should not be exposed on the login page");
  assert((await page.locator("#username").inputValue()) === "", "username should not be prefilled");
  assert((await page.locator("#password").inputValue()) === "", "password should not be prefilled");
  await page.locator("#username").fill("alice");
  await page.locator("#password").fill("doscloud");
  await page.locator("#login-form button[type=submit]").click();
  await page.waitForSelector(".game-card");

  const cardCount = await page.locator(".game-card").count();
  const rowCount = await page.locator(".catalog-row").count();
  const imageCount = await page.locator(".poster img").count();
  assert(cardCount >= 15, "expected at least 15 catalog cards across rendered rows");
  assert(rowCount <= 3, "catalog should stay focused instead of duplicating games across many category rows");
  assert(imageCount >= 15, "catalog cards should use game screenshots");

  const keenCard = page.locator('.game-card[data-game="keen1"]').first();
  const action = keenCard.locator(".card-actions button").first();
  const label = await action.textContent();
  if (label.includes("Install")) {
    await action.click();
    await page.waitForFunction(() => {
      const card = document.querySelector('.game-card[data-game="keen1"]');
      return card && card.textContent.includes("Play");
    }, null, { timeout: 15000 });
  }

  const launchResponse = await page.evaluate(async () => {
    const r = await fetch("/api/library/keen1/launch", { method: "POST" });
    return { status: r.status, body: await r.json() };
  });
  assert(launchResponse.status === 201, "Keen launch session was not created");

  const runtime = await context.newPage();
  await runtime.goto(new URL("/runtime.html?session=" + encodeURIComponent(launchResponse.body.session.id), base).href, { waitUntil: "domcontentloaded" });
  await runtime.waitForFunction(() => document.querySelector("#runtime-status")?.textContent?.includes("ready"), null, { timeout: 20000 });
  await runtime.waitForFunction(() => !!window.__ci, null, { timeout: 20000 });
  await runtime.waitForTimeout(5000);

  const runtimeTitle = await runtime.locator("#runtime-title").textContent();
  assert(runtimeTitle.includes("Commander Keen"), "generic runtime did not load Commander Keen metadata");
  const runningProgram = await runtime.evaluate(() => window.__ci.getRunningProgram());
  assert(String(runningProgram).toUpperCase().includes("KEEN"), "Commander Keen did not become the running DOS program: " + runningProgram);

  await page.screenshot({ path: "docs/phase3-catalog.png", fullPage: true });
  await runtime.screenshot({ path: "docs/phase3-runtime.png", fullPage: true });

  assert(fatal.length === 0, fatal.join("\n"));
  console.log(JSON.stringify({ catalogCards: cardCount, catalogRows: rowCount, screenshotCards: imageCount, runtimeTitle, runningProgram, login: "alice", result: "PASS" }, null, 2));
} finally {
  await browser.close();
}
