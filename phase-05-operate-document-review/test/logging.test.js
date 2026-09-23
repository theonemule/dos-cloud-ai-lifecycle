const test = require("node:test");
const assert = require("node:assert/strict");
const { createLogger, sanitize, formatSyslog } = require("../src/platform/logger");
const { startApp } = require("./helpers");

test("logging: sensitive values are redacted recursively", () => {
  const safe = sanitize({
    username: "alice",
    password: "dont-log-me",
    nested: {
      clientSecret: "also-secret",
      authorization: "Bearer token",
      value: 42,
    },
  });

  assert.equal(safe.username, "alice");
  assert.equal(safe.password, "[REDACTED]");
  assert.equal(safe.nested.clientSecret, "[REDACTED]");
  assert.equal(safe.nested.authorization, "[REDACTED]");
  assert.equal(safe.nested.value, 42);
});

test("logging: JSON console output is structured and respects levels", () => {
  const lines = [];
  const logger = createLogger({
    target: "console",
    format: "json",
    level: "info",
    consoleWriter: line => lines.push(line),
  });

  logger.debug("not_emitted", { value: 1 });
  logger.info("test_event", { requestId: "req-1", password: "redacted" });
  logger.close();

  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.level, "info");
  assert.equal(event.event, "test_event");
  assert.equal(event.phase, 5);
  assert.equal(event.data.requestId, "req-1");
  assert.equal(event.data.password, "[REDACTED]");
});

test("logging: syslog target emits RFC5424-style frames", () => {
  const frames = [];
  const logger = createLogger({
    target: "syslog",
    level: "debug",
    syslogWriter: line => frames.push(line),
  });

  logger.warn("security_event", { code: "EORIGIN" });
  logger.close();

  assert.equal(frames.length, 1);
  assert.match(frames[0], /^<132>1 /);
  assert.match(frames[0], /security_event/);
  assert.match(frames[0], /EORIGIN/);
});

test("logging: formatter uses local0 facility by default", () => {
  const line = formatSyslog({
    ts: "2026-09-23T00:00:00.000Z",
    level: "info",
    hostname: "host",
    service: "dos-cloud",
    pid: 123,
    event: "event",
    data: {},
  });
  assert.match(line, /^<134>1 2026-09-23T00:00:00.000Z host dos-cloud 123 - - /);
});

test("operations: request correlation and readiness are exposed", async () => {
  const lines = [];
  const logger = createLogger({
    target: "console",
    format: "json",
    level: "debug",
    consoleWriter: line => lines.push(line),
  });
  const ctx = await startApp({ logger });

  try {
    let response = await fetch(ctx.base + "/ready", {
      headers: { "x-request-id": "phase5-test-request" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-request-id"), "phase5-test-request");
    assert.deepEqual(await response.json(), { ready: true, phase: 5 });

    response = await fetch(ctx.base + "/health");
    assert.equal(response.status, 200);
    const health = await response.json();
    assert.equal(health.phase, 5);

    await new Promise(resolve => setTimeout(resolve, 10));
    const events = lines.map(line => JSON.parse(line));
    assert.ok(events.some(event =>
      event.event === "http_request" &&
      event.data.requestId === "phase5-test-request" &&
      event.data.path === "/ready" &&
      event.data.statusCode === 200
    ));
  } finally {
    await ctx.close();
  }
});
