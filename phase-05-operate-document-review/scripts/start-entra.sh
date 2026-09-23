#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${DOS_CLOUD_ENTRA_ENV:-$ROOT/.env.entra}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing Entra configuration: $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

exec node "$ROOT/server.js"
