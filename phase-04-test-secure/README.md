# DOS Cloud — Phase 4 Test and Secure

This snapshot starts from the completed Phase 3 multi-user DOS Cloud and adds regression testing plus security hardening.

## Lifecycle position

    Requirements -> Architecture -> Plan -> Code -> Test -> Secure -> Deploy -> Operate -> Document -> Change

Phase 4 covers Test and Secure.

## Test

Run the complete Node test suite:

    npm test

Run the regression scenarios only:

    npm run test:regression

Run security tests only:

    npm run test:security

Run real-browser end-to-end tests:

    npm run test:e2e

Run the full gate:

    npm run test:all

## Run locally

Normal startup does not create presentation accounts automatically.

    npm install
    npm start

To seed the presentation accounts explicitly:

    npm run seed
    npm start

or:

    DOS_CLOUD_SEED_DEMO_USERS=true npm start

For an HTTPS deployment behind TLS termination:

    DOS_CLOUD_SECURE_COOKIES=true npm start

Explicit alternate origins can be configured as a comma-separated allowlist:

    DOS_CLOUD_ALLOWED_ORIGINS=https://dos.example.com npm start



## HTTPS development certificate

Phase 4 can serve HTTPS directly with a self-signed development certificate.

Generate or regenerate it with:

    npm run cert:dev

The generated certificate includes SAN entries for localhost, 127.0.0.1, and the DevBox LAN address detected when the certificate is created.

Start HTTPS with:

    npm run start:https

HTTPS defaults to port 8443, so the DevBox URL is:

    https://10.0.1.183:8443/

Because this is self-signed, the browser will show a certificate warning until the development certificate is explicitly trusted on the client machine.

HTTPS mode automatically marks DOS Cloud session cookies Secure. Custom certificate paths can be supplied with:

    DOS_CLOUD_TLS_CERT=/path/server.crt
    DOS_CLOUD_TLS_KEY=/path/server.key

The generated PEM files are intentionally ignored by source control. scripts/generate-dev-cert.sh is the reproducible source for local development certificates.

Validate the HTTPS path with:

    npm run test:https

## OpenID Connect

Phase 4 supports generic OpenID Connect using Authorization Code + PKCE.

Minimum configuration:

    DOS_CLOUD_OIDC_ISSUER=https://identity.example.com
    DOS_CLOUD_OIDC_CLIENT_ID=dos-cloud
    DOS_CLOUD_OIDC_REDIRECT_URI=https://dos.example.com/api/auth/oidc/callback
    DOS_CLOUD_OIDC_PROVIDER_NAME="Company SSO"

For a confidential client, also set DOS_CLOUD_OIDC_CLIENT_SECRET.

For SSO-only deployment:

    DOS_CLOUD_LOCAL_AUTH_ENABLED=false
    DOS_CLOUD_LOCAL_REGISTRATION_ENABLED=false

The login page discovers configured authentication methods at runtime. Existing local accounts are never silently linked by matching username or email. Linking requires an authenticated Link SSO flow.

See docs/oidc.md for the full configuration and trust model.

## Security changes

Phase 4 adds:

- CSP and browser security headers
- same-origin enforcement for state-changing browser requests
- restrictive filesystem CORS
- auth rate limiting
- request and protocol size limits
- sanitized filesystem errors
- stronger local account validation
- production-style startup without automatic demo accounts
- TLS-aware Secure cookies
- dependency remediation for ZIP handling

See docs/security-hardening.md for the implemented controls and the production hardening backlog.

See docs/regression-suite.md for the regression strategy and test matrix.
