# ADR 0005: Keep IPX Networking Separate from the Filesystem Data Plane

Implemented by ADR 0006 in Phase 6.

Status: Accepted

## Decision

Future multiplayer uses a room-scoped WebSocket/IPX relay that is separate from persistent filesystem RPC.

The two capabilities may share authentication and launch-session context but do not share transport semantics or storage behavior.

## Rationale

Filesystem operations are stateful persistent storage operations. IPX traffic is ephemeral low-latency packet forwarding. Combining them would couple unrelated workloads and complicate authorization and observability.

## Consequences

- launch sessions may later reference a room ID
- catalog manifests may declare IPX capability
- each multiplayer participant still uses an independent user C: drive
- no game-specific multiplayer logic is required in the platform
