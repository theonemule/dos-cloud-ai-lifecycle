# Operations Guide

## Health model

Liveness:

    GET /health

This checks that the Node process is serving requests.

Readiness:

    GET /ready

This checks that the configured metadata database responds and that the mounted user-drive filesystem is readable and writable.

Azure Container Apps uses both endpoints as probes.

## Structured logging

Phase 5 emits structured events with:

- timestamp
- level
- event name
- service
- lifecycle phase
- environment
- host
- process ID
- event-specific data

Examples of event names include:

    server_started
    server_shutdown_started
    http_request
    request_failed
    auth_login_succeeded
    auth_user_registered
    auth_logout
    oidc_login_started
    oidc_login_completed
    oidc_link_started
    game_installed
    game_uninstalled
    game_launch_created
    console_launch_created
    filesystem_rpc_failed
    readiness_failed

Passwords, secrets, bearer tokens, authorization values, cookies, and PKCE verifier fields are redacted recursively.

## Console logging

Recommended for containers:

    DOS_CLOUD_LOG_TARGET=console
    DOS_CLOUD_LOG_FORMAT=json
    DOS_CLOUD_LOG_LEVEL=info

Azure Container Apps collects stdout and stderr into the configured Log Analytics workspace.

Useful Log Analytics query for recent application logs:

    ContainerAppConsoleLogs_CL
    | where TimeGenerated > ago(1h)
    | extend Event = parse_json(Log_s)
    | where isnotempty(Event.event)
    | project TimeGenerated, Event.level, Event.event, Event.data
    | order by TimeGenerated desc

Errors:

    ContainerAppConsoleLogs_CL
    | where TimeGenerated > ago(6h)
    | extend Event = parse_json(Log_s)
    | where Event.level == "error" or Event.event == "request_failed"
    | project TimeGenerated, Event

## Syslog

The same event stream can be emitted as RFC5424-style messages over UDP.

Configuration:

    DOS_CLOUD_LOG_TARGET=console,syslog
    DOS_CLOUD_SYSLOG_HOST=syslog.example.net
    DOS_CLOUD_SYSLOG_PORT=514
    DOS_CLOUD_SYSLOG_PROTOCOL=udp4

Console can be removed from the target list if only syslog is desired.

## Correlation IDs

Each response contains x-request-id.

If a caller supplies an identifier matching the accepted safe format, the service keeps it. Otherwise it generates a UUID.

The same identifier appears in the http_request event and request-failure events, which allows application logs to be correlated with ingress or client reports.

## Persistent state

All mutable data can be relocated with:

    DOS_CLOUD_STATE_ROOT=/data

Under that path:

    /data/var/doscloud.db
    /data/user-data/users/

The Azure template mounts its persistent Azure Files share at /data.


## Persistent storage in Azure

The Azure deployment separates relational and filesystem state.

Azure Database for PostgreSQL Flexible Server stores users, sessions, installed-game metadata, launch sessions, catalog metadata, and OIDC state. The Container App authenticates to PostgreSQL with its user-assigned managed identity. Password authentication is disabled on the server.

Azure Files is mounted directly at `/data` and contains the DOS filesystem only:

    /data/user-data/users/<user-id>/C/

Games and the emulator read and write those files in place. There is no synchronization layer and no SQLite database stored or copied through Azure Files.

Local development continues to use SQLite when no PostgreSQL configuration is supplied.

## Backup

Azure backup has two independent concerns:

- PostgreSQL uses the Flexible Server backup/restore capability for relational state.
- Azure Files should be protected with Azure Files backup/snapshots appropriate to the storage account for DOS user drives.

A restore should recover both stores to compatible points in time, then validate `/ready`, sign-in, an installed game, and a known save.

## Restore

1. stop the application
2. restore the database and user-data into the configured state root
3. confirm ownership/permissions
4. start the application
5. call /ready
6. sign in with a test account
7. validate an installed game and a known save

## Capacity

Watch:

- Azure Files used capacity and IOPS
- application request latency
- 4xx/5xx rates
- filesystem RPC failures
- PostgreSQL connectivity/query errors
- Container App restarts
- Log Analytics ingestion

The application does not yet enforce per-user storage quotas. That remains an operational risk for an internet-facing deployment.
