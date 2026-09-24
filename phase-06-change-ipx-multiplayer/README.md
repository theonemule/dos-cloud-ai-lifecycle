# DOS Cloud — Phase 6 Change and IPX Multiplayer

Phase 6 takes the deployed/operational Phase 5 application and applies a substantial change after the original lifecycle is complete: DOS IPX multiplayer over a server-brokered WebSocket network.

## Multiplayer flow

For an installed multiplayer-enabled title:

1. The host selects **Multiplayer**.
2. DOS Cloud creates an ephemeral room and six-character code.
3. The host runtime starts DOSBox-X's IPX server and connects it to `/ws/ipx` through a custom js-dos `sharedNet` adapter.
4. Another authenticated user selects **Join Multiplayer** and enters the code.
5. That user receives an independent launch against their own persistent C: drive.
6. Their DOSBox-X IPX client joins the host peer through the same room relay.
7. The backend forwards opaque IPX payloads between room peers over WebSockets.

The server is the transport broker. The DOS game host remains the IPX host at the emulator level.

## Supported Phase 6 profiles

DOOM is fully automated for the room's configured player count using `IPXSETUP.EXE`.

Duke Nukem 3D launches its original `SETUP.EXE` with the IPX network already available. Select **Network Game** and use matching player settings on each participant.

The relay itself is game-independent. Additional IPX titles are enabled through manifest metadata.

## Run

    npm ci
    DOS_CLOUD_SEED_DEMO_USERS=true npm start

Open `http://localhost:8080`, sign in with two different accounts in different browser profiles/contexts, install DOOM, host from one account, and enter the generated code from the other.

## Tests

Server and relay tests:

    npm run test:multiplayer

Two real browser/DOSBox IPX sessions:

    npm run test:multiplayer:browser

Complete gate:

    npm run test:all

The browser multiplayer test proves both DOSBox-X instances connect through the WebSocket relay, exchange real IPX traffic, and advance into DOOM.

## Architecture

See `docs/ipx-multiplayer.md` for the room protocol, js-dos integration seam, security model, and scale-out considerations.

All Phase 5 operational features remain present, including OIDC, PostgreSQL support, persistent user files, structured logging, Docker, Azure Container Apps infrastructure, and GitHub deployment automation.
