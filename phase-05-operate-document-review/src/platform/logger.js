const dgram = require("node:dgram");
const os = require("node:os");

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SYSLOG_SEVERITY = { debug: 7, info: 6, warn: 4, error: 3 };
const REDACT_KEY = /(password|secret|token|authorization|cookie|set-cookie|code_verifier)/i;

function sanitize(value, depth = 0) {
  if (depth > 8) return "[TRUNCATED]";
  if (value == null || typeof value === "undefined") return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      code: value.code,
      stack: value.stack,
    };
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return "[BINARY " + value.length + " BYTES]";
  }
  if (Array.isArray(value)) return value.map(v => sanitize(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT_KEY.test(k) ? "[REDACTED]" : sanitize(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 4096) return value.slice(0, 4096) + "[...]";
  return value;
}

function normalizeEventName(event) {
  return String(event || "event").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 128);
}

function formatSyslog(event, { facility = 16 } = {}) {
  const severity = SYSLOG_SEVERITY[event.level] ?? 6;
  const pri = facility * 8 + severity;
  const host = String(event.hostname || "-").replace(/\s/g, "_");
  const app = String(event.service || "dos-cloud").replace(/\s/g, "_");
  return "<" + pri + ">1 " + event.ts + " " + host + " " + app + " " + event.pid + " - - " + JSON.stringify(event);
}

function createLogger(options = {}) {
  const configuredLevel = String(options.level ?? process.env.DOS_CLOUD_LOG_LEVEL ?? "info").toLowerCase();
  const target = String(options.target ?? process.env.DOS_CLOUD_LOG_TARGET ?? "console").toLowerCase();
  const format = String(options.format ?? process.env.DOS_CLOUD_LOG_FORMAT ?? "json").toLowerCase();
  const service = options.service ?? process.env.DOS_CLOUD_SERVICE_NAME ?? "dos-cloud";
  const phase = Number(options.phase ?? 5);
  const environment = options.environment ?? process.env.NODE_ENV ?? "development";
  const hostname = os.hostname();
  const minLevel = LEVELS[configuredLevel] ?? LEVELS.info;
  const syslogHost = options.syslogHost ?? process.env.DOS_CLOUD_SYSLOG_HOST;
  const syslogPort = Number(options.syslogPort ?? process.env.DOS_CLOUD_SYSLOG_PORT ?? 514);
  const syslogProtocol = options.syslogProtocol ?? process.env.DOS_CLOUD_SYSLOG_PROTOCOL ?? "udp4";
  const consoleWriter = options.consoleWriter ?? (line => process.stdout.write(line + "\n"));
  const syslogWriter = options.syslogWriter;
  const targets = new Set(target.split(",").map(v => v.trim()).filter(Boolean));
  let socket = null;

  if (targets.has("syslog") && !syslogWriter && !syslogHost) {
    targets.delete("syslog");
    consoleWriter(JSON.stringify({
      ts: new Date().toISOString(),
      level: "warn",
      event: "syslog_disabled",
      reason: "DOS_CLOUD_SYSLOG_HOST is not set",
    }));
  }

  function emit(rawEvent) {
    if ((LEVELS[rawEvent.level] ?? LEVELS.info) < minLevel) return;
    const event = sanitize(rawEvent);

    if (targets.has("console")) {
      const line = format === "pretty"
        ? event.ts + " " + event.level.toUpperCase() + " " + event.event + " " + JSON.stringify(event.data || {})
        : JSON.stringify(event);
      consoleWriter(line);
    }

    if (targets.has("syslog")) {
      const line = formatSyslog(event);
      if (syslogWriter) {
        syslogWriter(line, event);
      } else {
        if (!socket) socket = dgram.createSocket(syslogProtocol);
        socket.send(Buffer.from(line), syslogPort, syslogHost, err => {
          if (err && targets.has("console")) {
            consoleWriter(JSON.stringify({
              ts: new Date().toISOString(),
              level: "warn",
              event: "syslog_send_failed",
              error: err.message,
            }));
          }
        });
      }
    }
  }

  function log(level, event, data = {}) {
    emit({
      ts: new Date().toISOString(),
      level,
      event: normalizeEventName(event),
      service,
      phase,
      environment,
      hostname,
      pid: process.pid,
      data,
    });
  }

  function child(base = {}) {
    return {
      debug(event, data = {}) { log("debug", event, { ...base, ...data }); },
      info(event, data = {}) { log("info", event, { ...base, ...data }); },
      warn(event, data = {}) { log("warn", event, { ...base, ...data }); },
      error(event, data = {}) { log("error", event, { ...base, ...data }); },
    };
  }

  return {
    debug(event, data) { log("debug", event, data); },
    info(event, data) { log("info", event, data); },
    warn(event, data) { log("warn", event, data); },
    error(event, data) { log("error", event, data); },
    child,
    close() {
      if (socket) socket.close();
      socket = null;
    },
  };
}

module.exports = {
  createLogger,
  sanitize,
  formatSyslog,
  LEVELS,
};
