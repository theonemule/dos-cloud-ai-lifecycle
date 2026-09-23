# DOS Cloud — Phase 5 Operate, Document, and Review

DOS Cloud is a browser-based DOS game platform. js-dos runs the game in the browser while the server owns the user's DOS C: drive. Users sign in, install catalog games into their own private filesystem, launch games in the browser, and keep saves, settings, and high scores on the server.

Phase 5 takes the secured Phase 4 build and adds operations, deployment, documentation, and final review.

## Run with Node

Install dependencies:

    npm ci

Start on port 8080:

    npm start

For the presentation accounts:

    DOS_CLOUD_SEED_DEMO_USERS=true npm start

Persistent state defaults to the phase directory. To place SQLite and user drives somewhere else:

    DOS_CLOUD_STATE_ROOT=/srv/dos-cloud npm start

Health checks:

    GET /health
    GET /ready

## Run with Docker

Build:

    docker build -t dos-cloud:phase5 .

Run with durable local state:

    docker volume create dos-cloud-state
    docker run --rm -p 8080:8080       -e DOS_CLOUD_SECURE_COOKIES=false       -e DOS_CLOUD_SEED_DEMO_USERS=true       -v dos-cloud-state:/data       dos-cloud:phase5

Docker Compose is also included:

    docker compose up --build

## Logging

Container deployments default to newline-delimited JSON on stdout.

Important variables:

    DOS_CLOUD_LOG_LEVEL=info
    DOS_CLOUD_LOG_TARGET=console
    DOS_CLOUD_LOG_FORMAT=json

To emit to an external syslog collector as well:

    DOS_CLOUD_LOG_TARGET=console,syslog
    DOS_CLOUD_SYSLOG_HOST=syslog.example.net
    DOS_CLOUD_SYSLOG_PORT=514
    DOS_CLOUD_SYSLOG_PROTOCOL=udp4

Every HTTP response gets an x-request-id header. Supplying a valid x-request-id causes the same value to be retained in application logs.

Sensitive password, secret, token, authorization, and cookie fields are redacted by the logger.

## OIDC

Phase 5 inherits the Phase 4 OpenID Connect implementation.

For Microsoft Entra ID, configure:

    DOS_CLOUD_OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
    DOS_CLOUD_OIDC_CLIENT_ID=<application-client-id>
    DOS_CLOUD_OIDC_CLIENT_SECRET=<secret-value>
    DOS_CLOUD_OIDC_REDIRECT_URI=https://<host>/api/auth/oidc/callback
    DOS_CLOUD_OIDC_PROVIDER_NAME=Microsoft Entra ID

The Azure deployment puts the client secret in Key Vault and exposes it to Container Apps through a Key Vault-backed Container Apps secret.


## GitHub Actions

Pushes to `main` run the Phase 5 Node regression suite and Docker build. After those pass, GitHub Actions authenticates to Azure using workload identity federation and deploys the commit to Azure Container Apps.

The GitHub deployment identity has no client secret. The DOS Cloud application's Entra client secret is stored in Azure Key Vault after the one-time bootstrap and is not stored in GitHub.

## Azure

See infra/azure/README.md.

The supplied Bicep creates:

- Azure Container Registry
- Container Apps environment
- Container App
- Log Analytics workspace
- Azure Storage and Azure Files
- user-assigned managed identity
- Azure Key Vault
- OIDC secret integration

Azure Files is mounted at /data so SQLite and user DOS drives survive revisions and restarts.

The deployment is intentionally limited to one replica because the current architecture uses SQLite.

## Tests

Run all Node tests:

    npm test

Run the browser gate:

    npm run test:e2e

Run everything:

    npm run test:all

## More documentation

- docs/application.md — how the application fits together
- docs/operations.md — logs, health, persistence, backup, and troubleshooting
- docs/runbook.md — common operator procedures
- docs/review.md — end-of-lifecycle review and remaining gaps
- docs/oidc.md — OIDC trust model and configuration
- infra/azure/README.md — Azure deployment
