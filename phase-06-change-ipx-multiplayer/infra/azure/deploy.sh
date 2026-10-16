#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

RESOURCE_GROUP="${AZURE_RESOURCE_GROUP:-dos-cloud-demo}"
LOCATION="${AZURE_LOCATION:-eastus2}"
PREFIX="${AZURE_PREFIX:-doscloud}"
IMAGE_TAG="${IMAGE_TAG:-phase6}"
OIDC_TENANT_ID="${DOS_CLOUD_OIDC_TENANT_ID:-370b5daf-d057-40e2-b543-e92ab092f30e}"
OIDC_CLIENT_ID="${DOS_CLOUD_OIDC_CLIENT_ID:-03f0affa-44d2-4209-b78e-97504b201e2b}"
MANAGE_OIDC_SECRET="${MANAGE_OIDC_SECRET:-false}"
OIDC_CLIENT_SECRET="${DOS_CLOUD_OIDC_CLIENT_SECRET:-}"
CREATE_RESOURCE_GROUP="${CREATE_RESOURCE_GROUP:-true}"
UPDATE_ENTRA_REDIRECT="${UPDATE_ENTRA_REDIRECT:-true}"

# Use distinct ARM deployment names, preventing "DeploymentActive" conflicts
# when an older workflow attempt still owns the default deployment record.
DEPLOYMENT_RUN_ID="${GITHUB_RUN_ID:-$(date -u +%s)-$}"
DEPLOYMENT_NAME="doscloud-${DEPLOYMENT_RUN_ID}-${GITHUB_RUN_ATTEMPT:-1}"

PARAMS="$(mktemp)"
trap 'rm -f "$PARAMS"' EXIT
chmod 600 "$PARAMS"

if [[ "$MANAGE_OIDC_SECRET" == "true" && -z "$OIDC_CLIENT_SECRET" ]]; then
  echo "DOS_CLOUD_OIDC_CLIENT_SECRET is required when MANAGE_OIDC_SECRET=true" >&2
  exit 1
fi

PARAMS="$PARAMS" OIDC_TENANT_ID="$OIDC_TENANT_ID" OIDC_CLIENT_ID="$OIDC_CLIENT_ID" OIDC_CLIENT_SECRET="$OIDC_CLIENT_SECRET" MANAGE_OIDC_SECRET="$MANAGE_OIDC_SECRET" python3 - <<'PY'
import json, os
manage = os.environ["MANAGE_OIDC_SECRET"].lower() == "true"
params={
  "$schema":"https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
  "contentVersion":"1.0.0.0",
  "parameters":{
    "oidcTenantId":{"value":os.environ["OIDC_TENANT_ID"]},
    "oidcClientId":{"value":os.environ["OIDC_CLIENT_ID"]},
    "manageOidcSecret":{"value":manage},
  }
}
if manage:
    params["parameters"]["oidcClientSecret"]={"value":os.environ["OIDC_CLIENT_SECRET"]}
with open(os.environ["PARAMS"],"w") as f:
    json.dump(params,f)
PY

if [[ "$CREATE_RESOURCE_GROUP" == "true" ]]; then
  az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --only-show-errors --output none
else
  az group show --name "$RESOURCE_GROUP" --only-show-errors --output none
fi

echo "Creating Azure foundation resources..."
FOUNDATION="$(az deployment group create --name "$DEPLOYMENT_NAME-foundation" --resource-group "$RESOURCE_GROUP" --template-file "$SCRIPT_DIR/main.bicep" --parameters "@$PARAMS" --parameters prefix="$PREFIX" imageTag="$IMAGE_TAG" deployApp=false --query properties.outputs --output json)"
REGISTRY="$(FOUNDATION="$FOUNDATION" python3 - <<'PY'
import json, os
print(json.loads(os.environ["FOUNDATION"])["registryName"]["value"])
PY
)"
POSTGRES_SERVER="$(FOUNDATION="$FOUNDATION" python3 - <<'PY'
import json, os
print(json.loads(os.environ["FOUNDATION"])["postgresServer"]["value"])
PY
)"
IDENTITY_NAME="$(FOUNDATION="$FOUNDATION" python3 - <<'PY'
import json, os
print(json.loads(os.environ["FOUNDATION"])["managedIdentityName"]["value"])
PY
)"
IDENTITY_PRINCIPAL_ID="$(FOUNDATION="$FOUNDATION" python3 - <<'PY'
import json, os
print(json.loads(os.environ["FOUNDATION"])["managedIdentityPrincipalId"]["value"])
PY
)"

echo "Waiting for PostgreSQL Flexible Server to become ready..."
PG_STATE=""
for _ in $(seq 1 60); do
  PG_STATE="$(az postgres flexible-server show     --resource-group "$RESOURCE_GROUP"     --name "$POSTGRES_SERVER"     --query state -o tsv 2>/dev/null || true)"
  if [[ "$PG_STATE" == "Ready" ]]; then
    break
  fi
  sleep 10
done
if [[ "$PG_STATE" != "Ready" ]]; then
  echo "PostgreSQL server did not become Ready; last state: $PG_STATE" >&2
  exit 1
fi

ADMIN_OBJECT_ID="$(az postgres flexible-server microsoft-entra-admin list   --resource-group "$RESOURCE_GROUP"   --server-name "$POSTGRES_SERVER"   --query '[0].objectId' -o tsv 2>/dev/null || true)"
if [[ "$ADMIN_OBJECT_ID" != "$IDENTITY_PRINCIPAL_ID" ]]; then
  echo "Configuring PostgreSQL Microsoft Entra administrator..."
  az postgres flexible-server microsoft-entra-admin create     --resource-group "$RESOURCE_GROUP"     --server-name "$POSTGRES_SERVER"     --display-name "$IDENTITY_NAME"     --object-id "$IDENTITY_PRINCIPAL_ID"     --type ServicePrincipal     --only-show-errors     --output none
fi

echo "Building and pushing image to $REGISTRY..."
az acr build --registry "$REGISTRY" --image "dos-cloud:$IMAGE_TAG" "$APP_ROOT" --only-show-errors --output none

echo "Deploying Azure Container App..."
OUTPUTS="$(az deployment group create --name "$DEPLOYMENT_NAME-application" --resource-group "$RESOURCE_GROUP" --template-file "$SCRIPT_DIR/main.bicep" --parameters "@$PARAMS" --parameters prefix="$PREFIX" imageTag="$IMAGE_TAG" deployApp=true --query properties.outputs --output json)"
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
