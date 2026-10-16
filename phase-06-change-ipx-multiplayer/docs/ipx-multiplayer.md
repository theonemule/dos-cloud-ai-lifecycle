# IPX Multiplayer Architecture

## Why a separate data plane

The persistent DOS C: drive and multiplayer networking have different semantics.

Filesystem traffic is request/response, durable, user-owned, and path-oriented. IPX traffic is transient, latency-sensitive, room-scoped, and packet-oriented. Phase 6 therefore keeps them separate even though both use WebSockets.

    DOS filesystem                          DOS networking
    --------------                          --------------
    DOSBox REMOTEFS                         DOS game IPX
          |                                      |
          v                                      v
    /ws/fs cached RPC                       js-dos Net interface
          |                                      |
          v                                      v
    user C: drive                           /ws/ipx room relay

## js-dos integration seam

js-dos 8.4.1 accepts a custom `sharedNet` implementation. DOS Cloud supplies a WebSocket-backed object implementing the js-dos `Net` contract:

- `peerId`
- `connected`
- `sendBinary`
- `recvBinary`
- `queryAliases`
- `registerAlias`
- `unregisterAlias`
- `disconnect`
- `shutdown`

For the room host, DOS Cloud also enables `startIpxServer`. js-dos tells DOSBox-X to start its built-in IPX server.

For a guest, DOS Cloud supplies `connectIpxAddress = "host"`. The custom `queryAliases` implementation resolves that alias to peer 1 only after the host's emulator has announced that its IPX server is running (see below), and js-dos invokes DOSBox-X's normal IPX connection path. js-dos resolves this alias before it creates the guest emulator, so the guest simply waits at that point.

### Host readiness handshake

A host WebSocket being online is not the same as the host's IPX server accepting registrations. In the js-dos 8.x DOSBox-X build, every inbound network packet on the host is queued for the IPX *server* only once `isIpxServer` is set; before that it lands in the host's own IPX *client* queue. When the host then starts its server and its loopback client connects, that client reads the guest's registration as if it were its own acknowledgement, fails an address check, and calls `abort()`, crashing the host emulator (`ERR! localIpxAddr.netnode mistmatch`).

To prevent this:

1. The host runtime boots immediately. js-dos sends `hand_ipx_startserver` and fires `ci-ready`.
2. The runtime watches the emulator log for `IPX: Connected to server`, which DOSBox-X prints after the server is running and the host's loopback client has registered. A 10-second fallback timer covers a missed log line.
3. The host sends `{"type":"ipx-server-ready"}` over `/ws/ipx`. The relay accepts this only from the room's host socket and broadcasts `host-ready` to the other members. Late joiners see `hostReady: true` in their `welcome`.
4. Guests resolve the `host` alias and connect.

Readiness resets whenever the host socket reconnects or leaves, because that means a new emulator instance. As a second guard, the host adapter drops inbound IPX frames until its own server is ready.

Because of this handshake, the runtime no longer waits for the room to fill before booting. Players can join at any time; the player count only matters to games whose own setup takes a node count, such as DOOM's `IPXSETUP -nodes N`.

The application therefore does not reimplement IPX itself. It replaces the transport beneath the emulator's existing IPX support.

## Room lifecycle

`POST /api/multiplayer/host`

Creates:

- a normal authenticated game launch
- an ephemeral room
- a six-character join code
- host peer ID 1

`POST /api/multiplayer/join`

Validates:

- the room exists and is not expired
- the room has capacity
- the account is not already in the room
- the same title is installed for the joining user

It then creates a separate game launch and assigns the next peer ID.

Rooms expire with their launch lifetime. They are intentionally transient and are not stored in PostgreSQL.

## WebSocket protocol

Endpoint:

    /ws/ipx?launch=<launch-session-id>

Authentication uses the existing DOS Cloud session cookie. The server derives room membership from the launch ID. The client never submits a room ID or user ID to the WebSocket relay.

Control messages are UTF-8 JSON. Server-generated messages are `welcome`, `peer-joined`, `peer-left`, `room-ready`, and `host-ready`.

The only client-originated control message is `{"type":"ipx-server-ready"}` (at most 256 bytes), honored only from the room host's current socket and ignored from anyone else. Any other text frame closes the connection with code 1003.

IPX payload messages are binary:

Client to server:

    uint32 big-endian target peer ID
    IPX payload bytes

Server to client:

    uint32 big-endian source peer ID
    IPX payload bytes

The relay does not parse or rewrite the emulated network packet. It only enforces the room boundary and forwards the opaque payload to the requested peer.

## Security boundaries

- WebSocket upgrades require an authenticated application session.
- The launch session must belong to the authenticated user.
- The launch session must have multiplayer room membership.
- Target peers are looked up only inside that room.
- Self-targeting and peer ID zero are ignored.
- Frame size is capped at 64 KiB plus the relay header.
- Per-message WebSocket compression is disabled.
- Slow peers are protected with a server-side buffered-amount threshold.
- A normal single-player launch cannot open `/ws/ipx`.

The six-character code is a discovery/invitation mechanism, not the authorization credential for the WebSocket. Authentication and launch ownership remain mandatory after the code is used.

## Game launch profiles

Multiplayer startup is metadata-driven.

DOOM uses:

    C:\GAMES\DOOM\DOOMS
    IPXSETUP.EXE -nodes <players>

With two browser runtimes in one room, the Phase 6 integration test verifies both emulators exchange IPX packets and reach `DOOM`.

Duke Nukem 3D uses:

    C:\GAMES\DUKE3D\DUKE3D
    SETUP.EXE

The user selects Network Game inside Duke's original setup program. The IPX transport is already established beneath DOSBox-X before Setup starts.

Additional games can be enabled by adding a `multiplayer` launch profile to their catalog manifest without changing relay code.

## Scale-out

The relay is intentionally process-local in Phase 6. The current Container Apps template is pinned to one replica, matching that design.

A scale-out implementation would need one of these approaches:

- a room-aware relay service separate from the web application
- a distributed message backplane plus connection directory
- deterministic room-to-replica routing with connection affinity

The persistent user drive does not need to be shared between players. Each multiplayer participant continues to run from their own C: drive.
