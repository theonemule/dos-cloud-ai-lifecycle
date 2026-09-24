const STATE = 0;
const REQUEST_LENGTH = 1;
const RESPONSE_LENGTH = 2;
const ERROR_CODE = 3;

let control = null;
let requestBytes = null;
let responseBytes = null;
let launch = null;
let session = null;
let socket = null;
let opening = null;
let pending = null;

function diag(stage, detail) {
  try { self.postMessage({ type: "diagnostic", stage, detail: detail || null }); } catch {}
}

function finish(errorCode, response) {
  const bytes = response ? new Uint8Array(response) : null;
  if (bytes && bytes.length > responseBytes.length) {
    errorCode = 2;
  } else if (bytes) {
    responseBytes.set(bytes.subarray(0, responseBytes.length), 0);
    Atomics.store(control, RESPONSE_LENGTH, bytes.length);
  } else {
    Atomics.store(control, RESPONSE_LENGTH, 0);
  }
  Atomics.store(control, ERROR_CODE, errorCode);
  Atomics.store(control, STATE, 2);
  Atomics.notify(control, STATE, 1);
}

function failPending(code) {
  if (!pending) return;
  const current = pending;
  pending = null;
  clearTimeout(current.timer);
  current.reject(Object.assign(new Error("filesystem WebSocket failed"), { bridgeCode: code }));
}

function socketUrl() {
  const here = new URL(self.location.href);
  const protocol = here.protocol === "https:" ? "wss:" : "ws:";
  return protocol + "//" + here.host + "/ws/fs?launch=" + encodeURIComponent(launch) + "&session=" + encodeURIComponent(session);
}

function ensureSocket() {
  if (socket && socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);
  if (opening) return opening;

  opening = new Promise((resolve, reject) => {
    const url = socketUrl();
    diag("socket-opening", url);
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("filesystem WebSocket connect timeout"));
    }, 10000);

    ws.onopen = () => {
      clearTimeout(timer);
      socket = ws;
      opening = null;
      diag("socket-open", url);
      resolve(ws);
    };

    ws.onmessage = event => {
      if (!pending) return;
      const current = pending;
      pending = null;
      clearTimeout(current.timer);
      current.resolve(event.data);
    };

    ws.onerror = event => {
      diag("socket-error", String(event?.message || "websocket error"));
      if (ws.readyState !== WebSocket.OPEN) {
        clearTimeout(timer);
        opening = null;
        reject(new Error("filesystem WebSocket connect failed"));
      }
      failPending(3);
    };

    ws.onclose = event => {
      diag("socket-close", { code: event.code, reason: event.reason || "" });
      if (socket === ws) socket = null;
      if (opening) opening = null;
      failPending(4);
    };
  });

  return opening;
}

async function performRpc() {
  try {
    const length = Atomics.load(control, REQUEST_LENGTH);
    if (length <= 0 || length > requestBytes.length) {
      finish(5);
      return;
    }

    const request = requestBytes.slice(0, length);
    const ws = await ensureSocket();
    const response = await new Promise((resolve, reject) => {
      if (pending) {
        reject(new Error("concurrent filesystem WebSocket RPC"));
        return;
      }
      const timer = setTimeout(() => {
        if (pending) pending = null;
        reject(new Error("filesystem WebSocket RPC timeout"));
        try { ws.close(); } catch {}
      }, 30000);
      pending = { resolve, reject, timer };
      try {
        ws.send(request);
      } catch (err) {
        pending = null;
        clearTimeout(timer);
        reject(err);
      }
    });

    finish(0, response);
  } catch (err) {
    finish(Number(err && err.bridgeCode) || 1);
  }
}

self.onmessage = event => {
  const message = event.data || {};
  if (message.type === "init") {
    control = new Int32Array(message.control);
    requestBytes = new Uint8Array(message.request);
    responseBytes = new Uint8Array(message.response);
    launch = String(message.launch || "");
    session = String(message.session || "");
    diag("initialized", { launch, session, hasWebSocket: typeof WebSocket !== "undefined" });
    ensureSocket().catch(err => diag("eager-connect-failed", String(err?.message || err)));
    return;
  }

  if (message.type === "rpc") {
    performRpc();
    return;
  }

  if (message.type === "close") {
    try { socket?.close(1000, "emulator closed"); } catch {}
    socket = null;
  }
};
