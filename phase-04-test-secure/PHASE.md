# Phase 4 — Test and Secure

Status: complete and validated snapshot

Phase 4 is forked from the completed Phase 3 build.

Its purpose is to demonstrate the next two lifecycle stages:

    Build -> Test -> Secure

No new product capability is introduced here. The emphasis is regression coverage, explicit trust boundaries, remediation of security findings, and a documented hardening backlog.

## Test work

Phase 4 preserves the Phase 3 tests and adds:

- lifecycle regression scenarios
- security regression tests
- session-expiration tests
- save persistence across launch sessions
- console and game shared-drive tests
- uninstall isolation tests
- browser policy tests
- cross-origin tests
- authentication throttling tests
- malformed protocol tests
- extended real-browser game stability checks

## Security work

Implemented:

- restrictive security headers
- CSP with runtime-only unsafe-eval
- same-origin mutation enforcement
- restrictive credentialed CORS
- login and registration throttling
- optional Secure cookies for TLS deployment
- stronger local account input policy
- JSON, filesystem, and protocol size limits
- sanitized filesystem errors
- demo-user seeding disabled by default
- generic OpenID Connect login using Authorization Code + PKCE
- signed ID-token, issuer, audience, state, nonce, and authorized-party validation
- explicit OIDC account linking rather than email or username auto-linking
- configurable OIDC auto-provisioning and SSO-only deployment
- self-signed development TLS certificate and direct HTTPS startup with automatic Secure cookies
- adm-zip upgraded to 0.6.1 after dependency audit findings

The remaining deployment and architectural recommendations are documented in docs/security-hardening.md.

Phase 3 remains the frozen build snapshot. Future deployment and operations work should fork from Phase 4.
