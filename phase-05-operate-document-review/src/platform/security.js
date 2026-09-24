function parseAllowedOrigins(value) {
  if (Array.isArray(value)) return new Set(value.filter(Boolean).map(String));
  return new Set(String(value || "")
    .split(",")
    .map(v => v.trim())
    .filter(Boolean));
}

function requestOriginAllowed(req, configuredOrigins = new Set()) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (configuredOrigins.size) return configuredOrigins.has(origin);

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  const host = String(req.headers.host || "").toLowerCase();
  return Boolean(host) &&
    parsed.host.toLowerCase() === host &&
    (parsed.protocol === "http:" || parsed.protocol === "https:");
}

function assertMutationOrigin(req, configuredOrigins) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method || "")) return;

  if (String(req.headers["sec-fetch-site"] || "").toLowerCase() === "cross-site") {
    throw Object.assign(new Error("cross-site state-changing request rejected"), {
      statusCode: 403,
      code: "ECROSSSITE",
    });
  }

  if (!requestOriginAllowed(req, configuredOrigins)) {
    throw Object.assign(new Error("request origin is not allowed"), {
      statusCode: 403,
      code: "EORIGIN",
    });
  }
}

function corsHeaders(req, configuredOrigins) {
  const origin = req.headers.origin;
  if (!origin || !requestOriginAllowed(req, configuredOrigins)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "vary": "Origin",
  };
}

function applySecurityHeaders(res, { allowUnsafeEval = false } = {}) {
  res.setHeader(
    "content-security-policy",
    [
      "default-src 'self'",
      allowUnsafeEval
        ? "script-src 'self' blob: 'unsafe-eval' 'wasm-unsafe-eval'"
        : "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join("; ")
  );
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("cross-origin-opener-policy", "same-origin");
  res.setHeader("cross-origin-embedder-policy", "require-corp");
  res.setHeader("cross-origin-resource-policy", "same-origin");
}

function clientKey(req) {
  return req.socket?.remoteAddress || "unknown";
}

function createRateLimiter({ max, windowMs, label }) {
  const buckets = new Map();

  function consume(key) {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.startedAt >= windowMs) {
      bucket = { startedAt: now, count: 0 };
      buckets.set(key, bucket);
    }

    if (bucket.count >= max) {
      const remainingMs = Math.max(1000, windowMs - (now - bucket.startedAt));
      throw Object.assign(new Error(label + " rate limit exceeded"), {
        statusCode: 429,
        code: "ERATELIMIT",
        headers: { "retry-after": String(Math.ceil(remainingMs / 1000)) },
      });
    }

    bucket.count++;
  }

  function clear() {
    buckets.clear();
  }

  return { consume, clear };
}

module.exports = {
  parseAllowedOrigins,
  requestOriginAllowed,
  assertMutationOrigin,
  corsHeaders,
  applySecurityHeaders,
  clientKey,
  createRateLimiter,
};
