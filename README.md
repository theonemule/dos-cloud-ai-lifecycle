# DOS Cloud — Full Lifecycle AI-Assisted Development Demo

DOS Cloud is a browser-based DOS gaming platform built as a conference demonstration of AI-assisted software engineering across an entire delivery lifecycle.

The application runs DOS games in the browser with js-dos/DOSBox-X while a Node server provides identity, catalog management, game installation, launch authorization, and a persistent server-authoritative DOS C: drive for each user.

The repository is intentionally organized as immutable lifecycle snapshots so the talk can show how the same project changes as requirements, architecture, testing, security, operations, and deployment concerns are introduced.

## Lifecycle

    Idea
      -> Requirements
      -> Architecture
      -> Plan
      -> Code
      -> Test
      -> Secure
      -> Operate
      -> Document
      -> Review

## Phase 1 — Idea, Requirements, Prototype

Directory:

    phase-01-idea-requirements-prototype

Establishes the idea and proves the unusual technical requirement: DOS inside the browser can use a server-authoritative file-oriented C: drive.

This phase contains the Commander Keen prototype and the REMOTEFS work that moved from an initial SharedArrayBuffer/WebSocket design to synchronous HTTP RPC inside the DOSBox worker.

## Phase 2 — Architecture and Plan

Directory:

    phase-02-architecture-plan

Freezes the target architecture before implementation.

It adds:

- multi-user storage isolation
- catalog and package manifests
- server-side installation
- metadata-driven launch
- local authentication
- short-lived launch capabilities
- DOS console
- future IPX design
- ADRs and diagrams
- implementation milestones

## Phase 3 — Build and Test

Directory:

    phase-03-build-test

Turns the architecture into a working multi-user product.

It includes:

- five seeded test accounts
- private per-user DOS C: drives
- 15-title shareware catalog
- Netflix-style catalog UI
- persistent saves and high scores
- generic metadata-driven game launch
- DOS console
- real browser tests across multiple DOS games

## Phase 4 — Test and Secure

Directory:

    phase-04-test-secure

Adds regression and security engineering.

It includes:

- lifecycle regression tests
- security regression tests
- OIDC using Authorization Code + PKCE
- Microsoft Entra ID support
- explicit SSO account linking
- CSP and security headers
- restrictive CORS and cross-site mutation protection
- request/protocol limits
- authentication throttling
- dependency remediation
- self-signed development HTTPS

Phase 4 remains the frozen security snapshot.

## Phase 5 — Operate, Document, Review

Directory:

    phase-05-operate-document-review

Adds the operational surface around Phase 4:

- structured JSON logging
- optional syslog output
- request IDs and timing
- liveness and readiness probes
- graceful shutdown
- Dockerfile and Docker Compose
- Azure Container Apps Bicep
- Azure Files persistent state
- Azure Container Registry
- Log Analytics
- Key Vault-backed OIDC secret
- managed identity
- Entra redirect-registration helper
- operator runbooks
- application documentation
- end-of-lifecycle review

Phase 5 is the frozen operations/documentation snapshot. Phase 6 is the current deployable snapshot.

## Phase 6 — Change, Refactor, and IPX Multiplayer

Directory:

    phase-06-change-ipx-multiplayer

Revisits the deployed design with a substantial new requirement: multiplayer DOS networking.

It adds:

- short multiplayer join codes
- authenticated room-scoped WebSocket relay
- a custom js-dos `sharedNet` transport
- DOSBox-X IPX host/client wiring
- independent per-player C: drives
- metadata-driven multiplayer launch profiles
- DOOM IPX multiplayer end to end
- Duke Nukem 3D network setup support
- multiplayer regression and two-browser integration tests

Phase 6 demonstrates the change/refactor loop after the original system is already built, secured, documented, and deployed.

## Quick start

    cd phase-06-change-ipx-multiplayer
    npm ci
    DOS_CLOUD_SEED_DEMO_USERS=true npm start

Then open:

    http://localhost:8080

For Docker:

    cd phase-06-change-ipx-multiplayer
    docker compose up --build

For Azure, see:

    phase-06-change-ipx-multiplayer/infra/azure/README.md

## Validation

Phase 6 Node tests:

    cd phase-06-change-ipx-multiplayer
    npm test

Full local test gate:

    npm run test:all

Docker image:

    docker build -t dos-cloud:phase6 .

The repository deliberately preserves the earlier snapshots rather than rewriting history. Each directory is presentation-ready and represents what the project looked like at that lifecycle stage.

## Third-party game packages

The catalog contains curated shareware packages used for the conference demo. Package manifests include source/provenance information and checksums.

Do not assume that every historical DOS title is redistributable merely because a download exists online. The catalog intentionally excludes titles for which a suitable redistributable shareware package was not established.
