#!/usr/bin/env bash
set -euo pipefail

CLIENT_ID="${1:?usage: configure-entra-redirect.sh <client-id> <redirect-uri>}"
REDIRECT_URI="${2:?usage: configure-entra-redirect.sh <client-id> <redirect-uri>}"

APP_OBJECT_ID="$(az ad app show --id "$CLIENT_ID" --query id -o tsv)"
EXISTING="$(az ad app show --id "$CLIENT_ID" --query 'web.redirectUris' -o json)"

MERGED="$(EXISTING="$EXISTING" REDIRECT_URI="$REDIRECT_URI" python3 - <<'PY'
import json, os
values=json.loads(os.environ.get("EXISTING") or "[]")
uri=os.environ["REDIRECT_URI"]
if uri not in values:
    values.append(uri)
print(json.dumps(values))
PY
)"

BODY="$(MERGED="$MERGED" python3 - <<'PY'
import json, os
print(json.dumps({"web":{"redirectUris":json.loads(os.environ["MERGED"])}}))
PY
)"

az rest \
  --method PATCH \
  --uri "https://graph.microsoft.com/v1.0/applications/$APP_OBJECT_ID" \
  --headers 'Content-Type=application/json' \
  --body "$BODY" \
  --only-show-errors

echo "Entra redirect URI registered: $REDIRECT_URI"
