#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$(mktemp -d)"
PORT="$(printenv E2E_PORT || true)"
if [ -z "$PORT" ]; then
  PORT="$(python3 - <<'PORTPY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PORTPY
)"
fi
LOG="$STATE/server.log"
PID=""
cleanup() {
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -rf "$STATE"
}
trap cleanup EXIT
cd "$ROOT"
PORT="$PORT" DOS_CLOUD_STATE_ROOT="$STATE" DOS_CLOUD_SEED_DEMO_USERS=true node server.js >"$LOG" 2>&1 &
PID=$!
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$PID" 2>/dev/null; then cat "$LOG"; exit 1; fi
  sleep .1
done
curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null
TEST_URL="http://127.0.0.1:$PORT/" node test/browser-smoke.mjs
TEST_URL="http://127.0.0.1:$PORT/" node test/multi-game-browser.mjs
