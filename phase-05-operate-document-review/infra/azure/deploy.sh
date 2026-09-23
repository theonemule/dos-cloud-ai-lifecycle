#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

RESOURCE_GROUP="${AZURE_RESOURCE_GROUP:-dos-cloud-demo}"
LOCATION="${AZURE_LOCATION:-eastus2}"
PREFIX="${AZURE_PREFIX:-doscloud}"
IMAGE_TAG="${IMAGE_TAG:-phase5}"
OIDC_TENANT_ID="${DOS_CLOUD_OIDC_TENANT_ID:-370b5daf-d057-40e2-b543-e92ab092f30e}"
OIDC_CLIENT_ID="${DOS_CLOUD_OIDC_CLIENT_ID:-03f0affa-44d2-4209-b78e-97504b201e2b}"
OIDC_CLIENT_SECRET="${DOS_CLOUD_OIDC_CLIENT_SECRET:?Set DOS_CLOUD_OIDC_CLIENT_SECRET in the environment.}"
UPDATE_ENTRA_REDIRECT="${UPDATE_ENTRA_REDIRECT:-true}"

PARAMS="$(mktemp)"
trap 'rm -f "$PARAMS"' EXIT
chmod 600 "$PARAMS"

PARAMS="$PARAMS" OIDC_TENANT_ID="$OIDC_TENANT_ID" OIDC_CLIENT_ID="$OIDC_CLIENT_ID" OIDC_CLIENT_SECRET="$OIDC_CLIENT_SECRET" python3 - <<'PY'
import json, os
params={
  "$schema":"https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
  "contentVersion":"1.0.0.0",
  "parameters":{
    "oidcTenantId":{"value":os.environ["OIDC_TENANT_ID"]},
    "oidcClientId":{"value":os.environ["OIDC_CLIENT_ID"]},
    "oidcClientSecret":{"value":os.environ["OIDC_CLIENT_SECRET"]},
  }
}
with open(os.environ["PARAMS"],"w") as f:
    json.dump(params,f)
PY

az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --only-show-errors --output none

echo "Creating Azure foundation resources..."
FOUNDATION="$(az deployment group create --resource-group "$RESOURCE_GROUP" --template-file "$SCRIPT_DIR/main.bicep" --parameters "@$PARAMS" --parameters prefix="$PREFIX" imageTag="$IMAGE_TAG" deployApp=false --query properties.outputs --output json)"
REGISTRY="$(FOUNDATION="$FOUNDATION" python3 - <<'PY'
import json, os
print(json.loads(os.environ["FOUNDATION"])["registryName"]["value"])
PY
)"

echo "Building and pushing image to $REGISTRY..."
az acr build --registry "$REGISTRY" --image "dos-cloud:$IMAGE_TAG" "$APP_ROOT" --only-show-errors --output none

echo "Deploying Azure Container App..."
OUTPUTS="$(az deployment group create --resource-group "$RESOURCE_GROUP" --template-file "$SCRIPT_DIR/main.bicep" --parameters "@$PARAMS" --parameters prefix="$PREFIX" imageTag="$IMAGE_TAG" deployApp=true --query properties.outputs --output json)"
APP_URL="$(OUTPUTS="$OUTPUTS" python3 - <<'PY'
import json, os
print(json.loads(os.environ["OUTPUTS"])["containerAppUrl"]["value"])
PY
)"
REDIRECT_URI="$(OUTPUTS="$OUTPUTS" python3 - <<'PY'
import json, os
print(json.loads(os.environ["OUTPUTS"])["oidcRedirectUri"]["value"])
PY
)"

if [[ "$UPDATE_ENTRA_REDIRECT" == "true" ]]; then
  "$SCRIPT_DIR/configure-entra-redirect.sh" "$OIDC_CLIENT_ID" "$REDIRECT_URI"
fi

echo
echo "DOS Cloud: $APP_URL"
echo "OIDC callback: $REDIRECT_URI"
echo "Resource group: $RESOURCE_GROUP"
