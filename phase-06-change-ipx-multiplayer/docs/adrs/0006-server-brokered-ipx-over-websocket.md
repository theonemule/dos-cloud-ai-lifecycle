# ADR 0006: Server-Brokered IPX over WebSockets

Status: Accepted and implemented in Phase 6

## Context

The application needs to support multiplayer DOS games that expect IPX while players run in browsers behind ordinary NAT/firewall boundaries. The existing filesystem path is not suitable as a network transport, and direct browser-to-browser connectivity would add a second NAT traversal system.

js-dos already exposes a `Net` abstraction beneath DOSBox-X's IPX support.

## Decision

Inject a DOS Cloud implementation of js-dos `sharedNet` that carries opaque emulator network payloads through an authenticated WebSocket endpoint at `/ws/ipx`.

A host creates an ephemeral room and receives a short join code. The host is peer 1 and DOSBox-X starts its built-in IPX server. Guests enter the code, receive their own launch sessions and peer IDs, then DOSBox-X connects to peer 1 through the same `Net` abstraction.

The relay is room-scoped and process-local. It does not parse IPX and it does not share a filesystem between players.

## Consequences

Positive:

- no inbound player ports
- no public player IP requirement
- no WebRTC/STUN/TURN dependency
- reuses DOSBox-X IPX behavior rather than reimplementing IPX
- one authenticated application origin for filesystem and multiplayer traffic
- game launch behavior remains manifest-driven

Tradeoffs:

- active rooms disappear on application restart
- one application replica is required until room routing is externalized
- WebSocket relay bandwidth passes through the application service
- each title still needs a correct multiplayer launch profile
- guests must not register until the host's emulator IPX server is running; the relay carries an explicit host-readiness handshake for this (see `docs/ipx-multiplayer.md`), and a future transport or js-dos upgrade must preserve that ordering
