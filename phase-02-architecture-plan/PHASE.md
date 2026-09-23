# Phase 2 — Architecture and Plan

Status: architecture and implementation plan drafted; no Phase 3 implementation started

This directory was forked from the completed Phase 1 snapshot.

Phase 2 converts the validated single-player filesystem prototype into an intentional architecture for a multi-user DOS gaming platform.

The selected direction includes:

- authenticated users
- a shared curated catalog
- Netflix-style card/library UX
- immutable game packages
- server-side installation into each user's private C: drive
- metadata-driven game launch
- a generic DOS console using the same user drive
- short-lived launch sessions that scope filesystem access
- SQLite metadata for the first implementation
- a modular-monolith server
- a future room-scoped IPX/WebSocket relay that remains separate from the filesystem data plane

Primary Phase 2 artifacts:

- docs/architecture.md
- docs/plan.md
- docs/diagrams/
- docs/adrs/
- docs/catalog-manifest-example.json

The Phase 1 prototype and its findings remain in this directory only as the starting baseline. The Phase 2 work is documentation and design; the product code has not yet been changed to implement the architecture.

The next repository snapshot should fork this directory into Phase 3 before implementation begins.
