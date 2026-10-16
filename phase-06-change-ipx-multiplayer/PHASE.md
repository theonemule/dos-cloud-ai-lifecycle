# Phase 6 — Change, Refactor, and IPX Multiplayer

Status: implemented and validated snapshot

Phase 6 forks the completed Phase 5 operational build and applies a substantial post-release change: multiplayer DOS networking.

The change preserves the existing server-authoritative C: drive and adds a second, independent data plane for IPX traffic.

## User flow

Host:

1. Install an IPX-enabled game.
2. Choose Multiplayer.
3. Select the player count (passed to games whose setup needs it, such as DOOM's `IPXSETUP -nodes`).
4. DOS Cloud creates a short room code and a multiplayer launch session.
5. The runtime opens an authenticated WebSocket to the room relay.
6. DOSBox-X starts its IPX server inside the host emulator, and the runtime announces it to the room once it is accepting registrations.
7. Share the six-character code with another player.

Guest:

1. Install the same game.
2. Choose Join Multiplayer and enter the code.
3. DOS Cloud creates an independent launch session against that user's own C: drive.
4. The browser joins the same WebSocket room.
5. DOSBox-X connects its IPX client to the host peer over the injected js-dos network transport.

No player requires inbound ports, a public IP address, or direct browser-to-browser connectivity.

## Implemented

- six-character multiplayer room codes
- authenticated host and join APIs
- room membership bound to authenticated launch sessions
- per-room numeric peer IDs
- `/ws/ipx` binary relay
- source and destination peer framing
- room isolation and capacity enforcement
- js-dos `sharedNet` adapter backed by WebSockets
- DOSBox-X IPX server/client integration
- multiplayer launch profiles in catalog manifests
- DOOM two-player automatic IPX startup
- Duke Nukem 3D network setup launch profile
- room information and copyable join code in the runtime
- structured multiplayer/IPX logging
- server and real two-browser multiplayer tests

## Proven end-to-end

The Phase 6 browser integration test starts two separate authenticated browser contexts, installs DOOM into each user's independent C: drive, creates and joins a room, starts the host IPX server, connects the client, relays real IPX traffic over the backend WebSocket, and verifies that both emulators advance through IPXSETUP into DOOM.

## Architectural constraint

Active room membership and WebSocket routing are process-local. The supplied Azure Container Apps configuration remains at one replica, so this is correct for the current deployment shape.

Horizontal scale would require an external room directory plus a relay/backplane strategy or deterministic connection affinity.
