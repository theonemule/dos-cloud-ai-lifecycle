# Application Overview

DOS Cloud is a multi-user browser DOS gaming platform.

The browser runs the emulator. The server owns identity, catalog metadata, installation state, launch authorization, and persistent DOS files.

## Main components

Browser application

- sign-in and account creation
- catalog and user library
- install, play, uninstall, and DOS console actions
- generic js-dos runtime

Node application

- local authentication and OpenID Connect
- catalog APIs
- per-user library APIs
- launch-session creation
- server-authoritative filesystem RPC
- health and readiness endpoints
- structured operational logging

Relational metadata store

Local development and tests use SQLite. The Azure deployment uses Azure Database for PostgreSQL Flexible Server for:

- users
- sessions
- game catalog metadata
- installed-game records
- launch sessions
- OIDC identities and short-lived OIDC transactions

User filesystem

Each user gets a private server directory that appears to DOS as C:.

Typical structure:

    user-data/users/<user-id>/C/
      GAMES/
      DOCS/
      USER/

Games are copied from immutable catalog packages into the user's GAMES directory. DOS writes made by the game therefore persist next to the installed game files in the user's private drive.

## Runtime flow

A normal launch is:

    Browser
      -> authenticated Play request
      -> short-lived launch session
      -> runtime page
      -> js-dos / DOSBox-X
      -> REMOTEFS
      -> synchronous filesystem RPC
      -> DriveStore
      -> user's private C: drive

The launch ID is both an authorization boundary and the mechanism that binds emulator filesystem traffic to the authenticated user's drive.

## Storage model

The application distinguishes immutable and mutable data.

Immutable image content:

- application source
- js-dos runtime
- game catalog manifests
- curated shareware packages
- card screenshots

Mutable state is deliberately split by storage semantics:

- relational metadata in PostgreSQL on Azure
- per-user DOS C: drives directly on Azure Files

For local development, SQLite remains the lightweight metadata implementation. In Azure, the Container App uses its user-assigned managed identity to authenticate to PostgreSQL and the Azure Files mount is used only as a filesystem.

## Authentication

Two authentication modes can coexist:

- local username and password
- generic OpenID Connect

OIDC uses Authorization Code, PKCE, state, nonce, signed ID-token validation, and explicit account linking.

An external username or email match never silently merges an external identity into an existing local account.

## Scale characteristics

The browser performs the CPU-heavy DOS emulation. Server load is primarily HTTP API work and filesystem I/O.

The Azure metadata store is PostgreSQL, so database state no longer constrains replicas. The remaining single-replica constraint is the process-local table of open emulator filesystem handles. Horizontal scaling requires that launch/filesystem handle affinity be externalized or explicitly routed to a stable replica.
