import { chromium } from "playwright-core";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const fatal = [];

  page.on("pageerror", (err) => fatal.push("pageerror: " + err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error" && /panic|REMOTEFS|Backend crashed/i.test(msg.text())) {
      fatal.push("console: " + msg.text());
    }
  });

  const testUrl = process.env.TEST_URL || "http://127.0.0.1:8080/";
  await page.goto(testUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__ci, null, { timeout: 15000 });
  await page.waitForFunction(
    () => document.querySelector("#status")?.textContent?.includes("Commander Keen is running"),
    null,
    { timeout: 15000 }
  );

  const result = await page.evaluate(async () => {
    const runningProgram = await window.__ci.getRunningProgram();
    const stats = await fetch("/api/stats?drive=demo").then((r) => r.json());
    return {
      runningProgram,
      status: document.querySelector("#status")?.textContent || "",
      controls: document.querySelectorAll(".control").length,
      focusNote: document.querySelector(".focus-note")?.textContent || "",
      stats,
      secureContext: window.isSecureContext,
      crossOriginIsolated: window.crossOriginIsolated,
      sharedArrayBuffer: typeof SharedArrayBuffer,
    };
  });

  assert(result.runningProgram === "KEEN1", "Commander Keen did not become the running DOS program");
  assert(result.status.includes("Commander Keen is running"), "UI never reported Keen running");
  assert(result.controls >= 8, "control legend is incomplete");
  assert(result.focusNote.includes("keyboard focus"), "keyboard focus instruction is missing");
  assert((result.stats.clients?.emulator || 0) >= 1, "emulator WebSocket never connected");
  assert((result.stats.bytesRead || 0) > 0, "emulator did not read game data remotely");
  assert((result.stats.bytesWritten || 0) > 0, "DOS-originated remote write was not observed");
  assert(fatal.length === 0, fatal.join("\n"));

  await page.screenshot({ path: "docs/keen-demo.png", fullPage: true });

  console.log(JSON.stringify({
    runningProgram: result.runningProgram,
    status: result.status,
    rpcRequests: result.stats.requests,
    bytesRead: result.stats.bytesRead,
    bytesWritten: result.stats.bytesWritten,
    controls: result.controls,
    secureContext: result.secureContext,
    crossOriginIsolated: result.crossOriginIsolated,
    sharedArrayBuffer: result.sharedArrayBuffer,
  }, null, 2));
} finally {
  await browser.close();
}
