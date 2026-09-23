#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$(mktemp -d)"
PORT="$(printenv E2E_HTTPS_PORT || true)"
if [[ -z "$PORT" ]]; then
  PORT="$(python3 - <<'PORTPY'
import socket
s=socket.socket()
s.bind(("127.0.0.1",0))
print(s.getsockname()[1])
s.close()
PORTPY
)"
fi
LOG="$STATE/server.log"
PID=""

cleanup() {
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -rf "$STATE"
}
trap cleanup EXIT

cd "$ROOT"
if [[ ! -s certs/dev-cert.pem || ! -s certs/dev-key.pem ]]; then
  npm run cert:dev >/dev/null
fi

PORT="$PORT" \
DOS_CLOUD_HTTPS=true \
DOS_CLOUD_STATE_ROOT="$STATE" \
DOS_CLOUD_SEED_DEMO_USERS=true \
node server.js >"$LOG" 2>&1 &
PID=$!

for _ in $(seq 1 80); do
  if curl -kfsS "https://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    cat "$LOG"
    exit 1
  fi
  sleep .1
done

curl -kfsS "https://127.0.0.1:$PORT/health" >/dev/null

COOKIE_HEADERS="$STATE/login-headers.txt"
curl -kisS \
  -H 'content-type: application/json' \
  --data '{"username":"alice","password":"doscloud"}' \
  "https://127.0.0.1:$PORT/api/auth/login" \
  -D "$COOKIE_HEADERS" \
  -o /dev/null

grep -qi '^set-cookie: .*HttpOnly' "$COOKIE_HEADERS"
grep -qi '^set-cookie: .*SameSite=Lax' "$COOKIE_HEADERS"
grep -qi '^set-cookie: .*Secure' "$COOKIE_HEADERS"

TEST_URL="https://127.0.0.1:$PORT/" \
TEST_IGNORE_HTTPS_ERRORS=true \
node test/browser-smoke.mjs
