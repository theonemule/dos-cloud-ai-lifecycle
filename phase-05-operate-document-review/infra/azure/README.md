# Azure Container Apps Deployment

This deployment creates the supporting Azure resources for DOS Cloud Phase 5:

- Azure Container Registry
- Azure Container Apps environment
- Azure Container App
- Log Analytics workspace
- Azure Storage account and Azure Files share
- user-assigned managed identity
- Azure Key Vault containing the OIDC client secret

The immutable application, emulator runtime, catalog manifests, and shareware packages are baked into the image.

The Azure Files share is mounted at `/data`. With `DOS_CLOUD_STATE_ROOT=/data`, the application persists:

- `/data/var/doscloud.db` for SQLite metadata and sessions
- `/data/user-data/users/...` for each user's DOS C: drive, saves, configuration, and high scores

The deployment deliberately fixes the Container App to one replica. SQLite plus a network filesystem is a demonstration/small-scale design, not a scale-out database architecture.

## Deploy

Requirements:

- Azure CLI
- an Azure subscription
- permission to create the resources in the target resource group
- permission to update the existing Entra app registration for the one-time bootstrap
- the Entra client-secret value only for the one-time Key Vault bootstrap

One-time bootstrap from an authenticated operator workstation:

    export DOS_CLOUD_OIDC_CLIENT_SECRET='...'
    export AZURE_RESOURCE_GROUP=dos-cloud-demo
    export AZURE_LOCATION=eastus2
    export MANAGE_OIDC_SECRET=true
    ./infra/azure/deploy.sh

`MANAGE_OIDC_SECRET=true` writes the application OIDC secret into Key Vault. Normal CI/CD deployments leave this false, so the secret never has to be stored in GitHub.

Defaults are already set for the current Entra tenant and application/client ID.

The deploy script performs two deployments. The first creates ACR and the platform resources. It then runs `az acr build` against Phase 5 and performs a second deployment that creates the Container App using that image.

The bootstrap can also add the generated Container Apps HTTPS callback to the existing Entra app registration without removing existing redirect URIs.

Set this to skip the Graph update:

    UPDATE_ENTRA_REDIRECT=false ./infra/azure/deploy.sh

## TLS

Azure Container Apps terminates HTTPS at ingress. The Node process listens on HTTP port 8080 inside the environment.

`DOS_CLOUD_SECURE_COOKIES=true` remains enabled, so browser sessions are still Secure cookies.

The self-signed Phase 4/5 development certificate is not used in Azure.

## Logging

The app writes newline-delimited JSON to stdout. The Container Apps environment sends application console logs to the deployed Log Analytics workspace.

The application can also emit RFC5424-style syslog over UDP to an external collector by changing the logging environment variables.

## Persistence warning

The current application stores both metadata and user filesystem state under one mounted Azure Files share. This makes the deployment faithful to the existing application architecture, but it intentionally keeps `minReplicas=1` and `maxReplicas=1`.

A future scale-out version should move metadata/session state from SQLite to a managed database while retaining Azure Files or another durable object/filesystem design for DOS user drives.


## GitHub Actions deployment

The repository workflow uses GitHub OIDC federation to Azure. No Azure client secret is stored in GitHub.

Repository variables provide:

- AZURE_CLIENT_ID
- AZURE_TENANT_ID
- AZURE_SUBSCRIPTION_ID
- AZURE_RESOURCE_GROUP
- AZURE_LOCATION
- AZURE_PREFIX
- DOS_CLOUD_OIDC_TENANT_ID
- DOS_CLOUD_OIDC_CLIENT_ID

The Azure deployment identity has Owner only on the `dos-cloud-demo` resource group. Its federated credential trusts only the `main` branch of `theonemule/dos-cloud-ai-lifecycle`.

After tests pass on a push to `main`, the workflow signs into Azure with `azure/login`, runs the same Bicep deployment, builds the commit into ACR, and updates the Container App revision.

The DOS Cloud application's own Entra client secret remains in Azure Key Vault and is referenced by the Container App through its managed identity.
