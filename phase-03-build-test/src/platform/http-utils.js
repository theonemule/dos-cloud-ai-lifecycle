function json(res, status, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": data.length,
    "cache-control": "no-store",
    ...headers,
  });
  res.end(data);
}

function text(res, status, body, headers = {}) {
  const data = Buffer.from(String(body));
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": data.length,
    ...headers,
  });
  res.end(data);
}

function readBody(req, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(Object.assign(new Error("request body too large"), { statusCode: 413, code: "EFBIG" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req, maxBytes) {
  const body = await readBody(req, maxBytes);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid JSON request body"), { statusCode: 400 });
  }
}

function handleError(res, err) {
  const status = Number(err.statusCode) || 500;
  json(res, status, {
    error: status >= 500 ? "internal server error" : err.message,
    code: err.code || undefined,
  });
  if (status >= 500) console.error(err);
}

module.exports = { json, text, readBody, readJson, handleError };
