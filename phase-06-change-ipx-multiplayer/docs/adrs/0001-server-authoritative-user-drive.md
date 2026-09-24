# ADR 0001: Server-Authoritative Per-User DOS Drive

Status: Accepted

## Decision

Each authenticated user receives a private server-side DOS C: drive. Runtime filesystem requests are resolved from an authenticated launch session to that user's storage root.

The client may not select an arbitrary user ID, drive ID, or physical storage path.

## Rationale

DOS software expects normal writable files and often stores saves, scores, configuration, and runtime data beside the executable. A server-authoritative user drive preserves those semantics while providing persistent cross-device state and strong user isolation.

## Consequences

- filesystem authorization becomes a central security boundary
- user drives consume server storage
- game files may be duplicated across users
- later storage optimization can use copy-on-write without changing the DOS-visible model
