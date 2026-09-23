# Phase 4 Security Review and Hardening

Phase 4 applies security controls that fit the current architecture without changing the product model established in Phase 2 and built in Phase 3. Larger controls are recorded separately as production recommendations.

## Hardening implemented in Phase 4

### Cross-origin and CSRF boundary

State-changing API requests reject hostile Origin values and browser requests marked Sec-Fetch-Site: cross-site.

The remote filesystem no longer reflects arbitrary origins. CORS credentials are returned only for an allowed same-host origin or an explicitly configured origin.

This closes the most obvious browser trust-boundary problem inherited from the prototype.

### Browser security headers

Responses now include:

- Content Security Policy
- X-Content-Type-Options: nosniff
- X-Frame-Options: DENY
- Referrer-Policy: no-referrer
- a restrictive Permissions-Policy
- Cross-Origin-Opener-Policy: same-origin
- Cross-Origin-Resource-Policy: same-origin

The main application does not allow unsafe-eval.

The current js-dos runtime requires JavaScript string evaluation, so unsafe-eval is allowed only on runtime.html. This exception is deliberately isolated and regression-tested rather than being added to the entire site.

### Session cookies

Session cookies remain HttpOnly, SameSite=Lax, and scoped to the application root.

Secure can be enabled for an HTTPS deployment with:

    DOS_CLOUD_SECURE_COOKIES=true

It is not forced in the development snapshot because the current LAN endpoint uses plain HTTP.

### Authentication throttling

Login and registration now have in-memory rate limits.

Defaults:

- login: 30 attempts per 5 minutes per client address
- registration: 10 attempts per hour per client address

These limits are intentionally simple for the single-process prototype. A distributed deployment should move them to shared infrastructure.

### Account input policy

Local account registration now requires:

- username: existing 3-32 character constrained format
- password: 8-128 characters
- display name: 1-80 printable characters

Control characters in display names are rejected.

### Request and protocol limits

- JSON request bodies default to a 64 KiB maximum
- filesystem RPC bodies are capped at 4 MiB
- filesystem protocol headers are capped at 64 KiB
- filesystem reads remain bounded by the drive service
- archive expansion remains bounded during install

Malformed filesystem packets fail closed.

### Error disclosure

Filesystem RPC errors no longer send internal exception text or host filesystem details to the browser. Clients receive an error code and a generic filesystem failure message.

### Test fixtures separated from production startup

The five presentation users are no longer automatically created by ordinary server startup.

Tests opt into them explicitly. A demo environment can opt in with:

    DOS_CLOUD_SEED_DEMO_USERS=true

This keeps test data from becoming an accidental production feature.

### Dependency remediation

The Phase 3 fork used adm-zip 0.5.x. npm audit identified current archive-handling advisories affecting that line.

Phase 4 upgrades to adm-zip 0.6.1.

Current production dependency audit result:

    found 0 vulnerabilities

The existing SHA-256 package checks and archive-path and expanded-size validation remain in place.

### External identity with OpenID Connect

A generic OpenID Connect path is now implemented in Phase 4.

It uses Authorization Code + PKCE, provider discovery, state, nonce, JWKS-based ID-token validation, issuer and audience validation, and optional UserInfo retrieval. External identities are keyed by issuer and subject.

Account linking is explicit. DOS Cloud does not trust a matching email address or username as sufficient proof to attach an external identity to an existing local account.

For a hosted environment, local login and registration can be disabled so MFA, recovery, conditional access, and password controls stay with the selected identity provider.

See docs/oidc.md.

### Development TLS support

Phase 4 can now serve TLS directly and includes a reproducible self-signed development-certificate generator.

HTTPS mode automatically enables the Secure attribute on session cookies. The certificate contains SANs for localhost, 127.0.0.1, and the detected DevBox LAN address.

The generated private key and certificate are not source-controlled.

This is intended for local and LAN validation only. A hosted deployment should use a certificate issued by a trusted internal or public CA.

## Recommended production hardening

These are not implemented in this snapshot because they either require deployment infrastructure or materially change the architecture.

### Use trusted TLS in production

The application now supports HTTPS directly, but the included certificate is self-signed for development.

For a hosted deployment, use a certificate issued by a trusted internal or public CA at the application or ingress layer. Keep Secure cookies enabled and add HSTS only after the production hostname and certificate lifecycle are established.

Do not expose account credentials or authenticated filesystem traffic over plain HTTP outside an isolated development network.

### Separate the emulator runtime origin

The strongest next browser isolation improvement is to host the DOS runtime on a dedicated origin.

That would contain the js-dos unsafe-eval requirement away from the account and catalog application and reduce the impact of a browser-emulator compromise.

### Add persistent quotas

Enforce per-user storage quotas and possibly per-title limits. Without quotas, a valid user can consume server storage through ordinary DOS writes.

Also apply limits to concurrent launch sessions and open filesystem handles.

### Harden game-package ingestion

Keep the catalog curated and administrative. Do not allow arbitrary user ZIP upload through the current install path.

For a production catalog pipeline:

- sign manifests
- retain source and license provenance
- scan packages before publication
- generate an SBOM for the service
- review emulator and package changes separately from user data
- store immutable catalog artifacts separately from writable user drives

### Run with OS and container isolation

Run the service as a non-root identity with:

- read-only application and catalog files
- writable mounts only for the database and user-drive storage
- restricted outbound network access
- CPU and memory limits
- process or container isolation
- regular backup and restore testing

### Centralize rate limiting and security telemetry

If the service scales beyond one process, move rate limits to shared infrastructure.

Record security-relevant events such as:

- repeated login failures
- rejected origins
- rejected launch-session access
- filesystem traversal attempts
- malformed protocol frames
- quota violations
- package integrity failures

Avoid logging session tokens, passwords, or save-file contents.

### Strengthen sessions

For an internet-facing service, consider:

- shorter interactive session lifetime
- explicit session revocation
- device and session listing
- password-change revocation
- rotating session identifiers after sensitive account actions

### Remove the runtime CSP exception eventually

The current emulator stack requires unsafe-eval on the runtime document. Prefer an emulator or runtime build that can operate without it. Once that is available, remove the exception and move toward a nonce or hash based CSP without unsafe-inline as well.

### Future IPX security boundary

Before multiplayer is implemented, define the relay as an authenticated room-scoped transport rather than a general network bridge.

At minimum enforce:

- authenticated room membership
- packet and frame size limits
- packet rate limits
- maximum peers per room
- room isolation
- protocol validation
- short-lived join credentials
- no arbitrary server-side network access

The browser should be able to exchange IPX frames only with peers in the same authorized session.
