# OpenID Connect Authentication

Phase 4 supports a generic OpenID Connect provider without changing the DOS Cloud user, library, or filesystem model.

An authenticated external identity resolves to an ordinary DOS Cloud user. The user's private C: drive, installed games, saves, high scores, launch sessions, and filesystem authorization continue to use the internal DOS Cloud user ID.

## Protocol

The login flow uses:

1. OpenID Provider discovery
2. Authorization Code flow
3. PKCE using S256
4. cryptographically random state
5. cryptographically random nonce
6. server-side code exchange
7. signed ID-token validation using the provider JWKS
8. issuer and audience validation
9. authorized-party validation when required
10. optional UserInfo retrieval with subject consistency validation
11. creation of the normal DOS Cloud server-side session

OIDC authorization state is stored server-side and expires after ten minutes. The state value stored in the database is hashed and a callback state is single-use.

## Required configuration

    DOS_CLOUD_OIDC_ISSUER=https://identity.example.com
    DOS_CLOUD_OIDC_CLIENT_ID=dos-cloud
    DOS_CLOUD_OIDC_REDIRECT_URI=https://dos.example.com/api/auth/oidc/callback

Optional configuration:

    DOS_CLOUD_OIDC_CLIENT_SECRET=<secret>
    DOS_CLOUD_OIDC_PROVIDER_NAME="Company SSO"
    DOS_CLOUD_OIDC_SCOPES="openid profile email"
    DOS_CLOUD_OIDC_USERNAME_CLAIM=preferred_username
    DOS_CLOUD_OIDC_NAME_CLAIM=name
    DOS_CLOUD_OIDC_EMAIL_CLAIM=email
    DOS_CLOUD_OIDC_EMAIL_VERIFIED_CLAIM=email_verified
    DOS_CLOUD_OIDC_AUTO_PROVISION=true

A hosted deployment should explicitly configure the redirect URI. Non-loopback OIDC endpoints and redirect URIs require HTTPS.

DOS_CLOUD_OIDC_ALLOW_HTTP=true exists only for controlled local testing and should not be used for an internet deployment.

## Public and confidential clients

If DOS_CLOUD_OIDC_CLIENT_SECRET is omitted, DOS Cloud performs a public-client token exchange with PKCE.

If a client secret is configured, DOS Cloud supports client_secret_basic and client_secret_post according to provider discovery metadata.

PKCE is used in both cases.

## Account provisioning

By default, a previously unseen issuer and subject pair is provisioned as a new DOS Cloud user.

Username selection uses the configured username claim, then email, then subject. If the resulting username already exists, DOS Cloud allocates a different username.

A matching username or email address does not link an external identity to an existing local account.

For example, if a local user named alice already exists and an OIDC identity arrives with preferred_username=alice, DOS Cloud creates a distinct account such as alice-xxxxxx.

Automatic provisioning can be disabled with:

    DOS_CLOUD_OIDC_AUTO_PROVISION=false

## Explicit account linking

When OIDC is configured, an authenticated local user who does not yet have an identity from that provider sees a Link SSO action.

The link operation creates a new state, nonce, and PKCE verifier and records the current internal user ID in the short-lived OIDC transaction. After the external identity is validated, the exact issuer and subject pair is attached to that user.

An external identity cannot be linked to two DOS Cloud users, and one DOS Cloud user cannot have two different subjects from the same issuer.

## SSO-only deployment

Local login and local registration can be disabled independently.

    DOS_CLOUD_LOCAL_AUTH_ENABLED=false
    DOS_CLOUD_LOCAL_REGISTRATION_ENABLED=false

The browser calls /api/auth/methods and automatically hides disabled authentication methods.

For the conference/demo environment, local login can remain enabled alongside SSO.

## Session behavior

OIDC ultimately creates the same DOS Cloud session used by local authentication.

The browser never receives the OIDC client secret, PKCE verifier, or provider access token. Provider tokens are used only during the callback flow and are not stored as long-lived account credentials.

Signing out of DOS Cloud removes the DOS Cloud session. Provider-wide single logout is not implemented yet.

## Test coverage

test/oidc.test.js uses a local mock OpenID Provider with an RSA signing key and JWKS endpoint. It validates the complete redirect and token flow, including:

- discovery
- S256 PKCE
- state
- nonce
- signed ID-token validation
- auto-provisioning
- repeat sign-in
- collision handling
- explicit account linking
- single-use state after failed validation
- SSO-only mode

Run it with:

    npm run test:oidc
