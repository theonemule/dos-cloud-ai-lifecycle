# Phase 4 Regression Suite

The Phase 4 test suite treats Phase 3 behavior as a contract. Tests are split into layers so failures identify whether the regression is in core behavior, security policy, or the real browser runtime.

## Core and integration tests

npm test runs the filesystem, platform, regression, and security suites.

The existing Phase 3 integration tests continue to cover:

- DOS-style case-insensitive filesystem behavior
- traversal rejection
- catalog integrity and package checksums
- per-user library isolation
- per-user filesystem isolation
- generic metadata-driven installation and launch
- DOS console launch
- save and high-score persistence
- launch-session ownership
- account registration
- authentication enforcement
- installation and launch validation for every catalog package

## Added regression scenarios

test/regression.test.js adds lifecycle-level scenarios that exercise behavior across multiple API calls and launch sessions.

| Regression | Contract being protected |
| --- | --- |
| Install, launch, save, relaunch | A save created through one launch session is readable from a later launch session for the same user |
| DOS console to game | Console and game sessions mount the same personal C drive |
| User-scoped uninstall | Uninstall affects only the owning user's copy and prevents that user from launching it afterward |
| Logout | A logged-out cookie cannot continue using authenticated APIs |
| Expired launch | Expired launch session IDs cannot be replayed |
| Catalog contract | IDs remain unique and every catalog entry keeps a local screenshot and verified-shareware status |

Run only these tests with:

    npm run test:regression

## Security regressions

test/security.test.js verifies controls that should not silently disappear during later development:

- security headers and CSP
- unsafe-eval scoped to the emulator runtime only
- cookie attributes
- cross-site mutation rejection
- restrictive filesystem CORS
- launch-session IDOR protection
- cross-user filesystem isolation
- traversal protection
- malformed filesystem protocol handling
- sanitized filesystem error responses
- authentication throttling
- request body limits
- account input policy
- production startup without implicit demo users

Run only these tests with:

    npm run test:security

## OIDC regression

test/oidc.test.js runs a local OpenID Provider with RSA-signed ID tokens and a JWKS endpoint. The suite exercises the complete server-side authentication flow rather than mocking the OIDC service internals.

It covers PKCE, state, nonce, signed-token validation, provisioning, repeat login, collision handling, explicit linking, and SSO-only configuration.

Run it with:

    npm run test:oidc

## Browser regression

npm run test:e2e starts an isolated temporary Phase 4 instance and validates the actual browser application.

It checks the catalog/login flow and actual execution of:

- Commander Keen 1
- DOOM
- Wolfenstein 3D
- Duke Nukem 3D

The multi-game check keeps the runtimes alive long enough to detect the backend crash and rendering regression found during Phase 3 stabilization.

## Full gate

Use this before moving to the next lifecycle phase:

    npm run test:all

The E2E runner uses temporary state and explicitly enables the seeded test accounts. Normal server startup does not seed those accounts automatically.
