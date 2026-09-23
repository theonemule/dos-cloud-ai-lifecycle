# Phase 3 — Build and Test

Status: complete / runnable snapshot

Phase 3 implements the architecture and plan captured in Phase 2.

Implemented scope:

- local user registration, login, logout, and cookie sessions
- scrypt password hashing
- five seeded demo users
- private server-authoritative DOS C: drives
- 15 curated shareware catalog packages with source provenance and SHA-256 checksums
- checksum-verified server-side installation
- safe ZIP path validation before extraction
- installation into `C:\GAMES\<game>` inside each user's private drive
- user-specific library and recently-played state
- short-lived launch sessions
- filesystem RPC bound to an authenticated, owned launch session
- metadata-driven launch configuration with no game-specific server launch code
- generic browser DOSBox runtime
- persistent saves, high scores, configuration, and arbitrary DOS writes in each user's drive
- DOS console launch against the same personal C: drive
- Netflix-style catalog/library UI with card rows and install/play state
- generic account creation in addition to the demo users
- unit, integration, multi-user isolation, package-validation, and real-browser tests

Future IPX multiplayer remains represented in catalog capabilities and the Phase 2 architecture, but is intentionally not implemented in Phase 3.

Phase 3 is now the active runnable application. The next lifecycle snapshot should be forked from here before the security/deployment/operations phases modify it.
