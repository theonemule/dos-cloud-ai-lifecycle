# Operator Runbook

## Application will not become ready

Check:

1. /health
2. /ready
3. container console logs
4. Container Apps system logs
5. Azure Files mount status
6. permissions on /data
7. PostgreSQL connectivity or authentication errors

A healthy process with failed readiness usually indicates state-storage or database access rather than an HTTP listener problem.

## Users can sign in but games do not launch

Check for:

    game_launch_created
    request_failed
    filesystem_rpc_failed

Then verify:

- the title is installed for that user
- the launch session has not expired
- the user's C: drive exists
- the Azure Files mount remains writable

## OIDC login fails

Confirm:

- issuer tenant is correct
- client ID is correct
- client secret in Key Vault is the secret value
- Container Apps callback URI is registered under the Entra app's Web redirects
- redirect URI exactly matches the value shown by the Azure deployment output

Review OIDC events and request failures without logging provider tokens.

## Catalog install fails

Validate the catalog package checksum and archive path checks.

Check free space on the persistent share.

The package source is immutable in the container image. The destination is the authenticated user's private drive.

## High request latency

Use the http_request event duration and Azure ingress HTTP logs.

Separate:

- normal page/API requests
- game package installation
- filesystem RPC traffic

Browser DOS emulation itself does not consume server CPU.

## Container restart

The application handles SIGTERM by closing filesystem handles and the PostgreSQL connection pool before process exit.

After a revision restart:

1. check /ready
2. check server_started
3. verify Azure Files is mounted
4. test one login
5. launch one installed title

Existing in-browser launch sessions may need to be relaunched after a server restart because open filesystem handles are process-local.

## Rollback

Container Apps uses single-revision mode in the supplied Bicep.

To roll back:

1. redeploy the prior image tag
2. verify readiness
3. verify OIDC
4. test one installed title and save

Do not roll back across an incompatible database schema change without a database rollback plan.
