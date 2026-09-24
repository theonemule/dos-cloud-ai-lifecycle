> **Phase 6 update:** This is the original implementation plan preserved from the architecture stage. Phase 6 now implements the IPX room/relay seam that this plan described as future work.

# Phase 2 Implementation Plan

Status: implementation plan drafted for review  
Target: Phase 3 build

## 1. Objective

Turn the working Phase 1 filesystem prototype into a multi-user, catalog-driven, single-player DOS gaming platform while preserving the ability to add multiplayer later.

The implementation should be incremental. At the end of every milestone the application should still run.

The plan deliberately avoids implementing IPX multiplayer yet. Multiplayer architecture is defined now so the single-player implementation does not create a dead end.

## 2. Target User Journey

The completed implementation should support this sequence:

1. User opens DOS Cloud.
2. User signs in.
3. User sees a card-based catalog of available DOS games.
4. User selects a game.
5. If the game is not installed, the user clicks **Install**.
6. The server copies/extracts the catalog package into that user's private C: drive.
7. The card changes to **Play**.
8. User clicks **Play**.
9. A new browser tab opens.
10. DOSBox mounts that user's C: drive.
11. The game starts according to catalog launch metadata.
12. Saves, high scores, and configuration writes persist in the user's game directory.
13. The user can later open **DOS Console** and inspect/run the same installed games from the command prompt.
14. Another user can sign in and receives an entirely independent C: drive and library state.

## 3. Milestone Sequence

### Milestone 1 — Domain Model and Server Modules

Goal: create the structure required for the platform without changing visible behavior.

Create server modules:

```text
src/
├── auth/
├── catalog/
├── library/
├── launch/
├── filesystem/
├── persistence/
└── telemetry/
```

Move existing DriveStore and filesystem RPC handling under filesystem.

Introduce SQLite with migrations.

Create tables/models for users, games, user_games, and launch_sessions.

Acceptance criteria:

- current Commander Keen prototype still launches
- existing filesystem tests remain green
- schema can be created from an empty database
- modules have clear public interfaces
- no new UI behavior required yet

### Milestone 2 — User Accounts and Session Authentication

Goal: establish real user identity before creating per-user storage.

Implement:

```text
POST /api/auth/register
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/me
```

Create a user drive when the account is created:

```text
user-data/users/{user-id}/C/
```

Acceptance criteria:

- two users can create accounts
- sessions persist across page refresh
- each user has a distinct server-side drive root
- an unauthenticated user cannot call library, launch, or filesystem APIs

### Milestone 3 — Session-Scoped Remote Filesystem

Goal: remove the Phase 1 global demo drive.

Replace the current drive-selection behavior with:

```text
/api/fs?session={launchSessionId}
```

The server resolves:

```text
launchSession -> user -> user C: root
```

Do not accept user storage path or user ID from the runtime.

Acceptance criteria:

- User A cannot access User B's drive by modifying URL parameters
- two browser sessions can run concurrently with different drives
- existing read/write/seek/directory semantics remain intact
- file-handle state is isolated by launch session

### Milestone 4 — Catalog Manifest and Package Loader

Goal: make games data, not code.

Define and validate a manifest schema.

Create:

```text
catalog/
├── keen1/
│   ├── manifest.json
│   ├── cover.png
│   └── package.zip
└── ...
```

Implement:

```text
GET /api/catalog
GET /api/catalog/{gameId}
```

Seed the first catalog with Commander Keen.

Then add other legally verified shareware packages as available.

Each catalog entry must include stable ID, title, version, presentation metadata, package/checksum, install path, launch command, DOSBox settings, capabilities, and distribution/source metadata.

Acceptance criteria:

- Commander Keen can be removed from hard-coded browser code
- catalog endpoint fully describes how to install and launch Keen
- malformed manifests are rejected
- checksum is verified before install

### Milestone 5 — Library and Game Installation

Goal: install catalog packages into the authenticated user's C: drive.

Implement:

```text
GET    /api/library
POST   /api/library/{gameId}/install
DELETE /api/library/{gameId}
```

Install behavior:

1. authenticate
2. resolve catalog package
3. validate checksum
4. check install destination
5. safely extract/copy into user's drive
6. create user_games record
7. return installed state

Initial installation path:

```text
C:\GAMES\{install-directory}
```

Acceptance criteria:

- User A installing Keen does not install it for User B
- the browser is not in the package-copy data path
- a package cannot escape the user's drive through archive paths
- repeat install is idempotent
- uninstall only affects that user's installed copy

### Milestone 6 — Catalog and Library UI

Goal: replace the filesystem demonstration page with the product experience.

Build a card-based home page with horizontal rows:

- Installed Games
- Recently Played
- Featured
- Platformers
- Shooters
- Shareware Classics

Game card states:

```text
Not installed -> Install
Installing     -> Progress/disabled state
Installed      -> Play
```

Acceptance criteria:

- UI is generated from catalog API
- no game title is hard-coded into UI logic
- installed state is user-specific
- page works with several catalog entries

### Milestone 7 — Metadata-Driven Game Launch

Goal: make the runtime generic.

Implement:

```text
POST /api/library/{gameId}/launch
GET  /api/launch/{sessionId}
```

Runtime page:

```text
/play/{sessionId}
```

Runtime configuration is generated from manifest metadata.

Example generated AUTOEXEC:

```text
mount c /remote
c:
cd \GAMES\KEEN1
KEEN1.EXE
```

Acceptance criteria:

- same runtime page can launch multiple games
- no Commander Keen executable/path is hard-coded in runtime JavaScript
- launch fails if game is not installed
- session expires after configurable lifetime
- game writes remain in the user's C: drive
- last-played timestamp is updated

### Milestone 8 — DOS Console

Goal: expose the user's personal DOS environment directly.

Implement:

```text
POST /api/console/launch
```

Open:

```text
/console/{sessionId}
```

Generated AUTOEXEC:

```text
mount c /remote
c:
cd \
```

Acceptance criteria:

- user lands at C:\>
- DIR shows only that user's drive
- installed games are visible beneath C:\GAMES
- user can manually start an installed game
- files written from the console persist in the same user drive
- console cannot navigate outside the server-authorized C: root

### Milestone 9 — Multiple-User Validation

Goal: prove the platform rather than merely the UI.

Automated browser scenario:

```text
Create User A
Create User B

User A:
  install Keen
  run Keen
  create/save user-specific data

User B:
  library initially empty
  install Keen separately
  does not see User A's files

User A:
  open DOS console
  verify User A state remains present
```

Add explicit isolation tests for guessed launch-session IDs, modified game IDs, path traversal, stale sessions, cross-user file handles, and uninstall boundaries.

### Milestone 10 — Catalog Expansion

Goal: make the platform visibly feel like a catalog rather than a Keen demo.

Curate a small set of redistributable DOS packages.

Candidate categories:

- Commander Keen shareware episodes
- DOOM shareware
- Wolfenstein 3D shareware
- Duke Nukem 3D shareware
- other Apogee shareware titles
- additional DOS demos/shareware only after distribution rights are verified

For each game:

- retain original source URL
- record distribution/license notes
- compute checksum
- create manifest
- add legally usable presentation assets
- verify launch command
- verify save/high-score behavior

Do not assume a game is redistributable merely because an old downloadable copy exists online.

## 4. Future Milestone — Multiplayer Foundation

This is intentionally not part of the immediate single-player implementation, but the following seams must remain intact:

- GAME.capabilities.ipx
- optional launch_session.room_id
- runtime accepts injected networking configuration
- server has a separate route/module namespace for rooms/networking
- filesystem session and network room remain separate concepts

Later implementation:

```text
Create Room
 -> Join Room
 -> Launch Game with roomId
 -> Runtime instantiates IPX Net adapter
 -> WebSocket connects to room-scoped relay
 -> Relay forwards IPX frames only among room members
```

The platform does not need game-specific multiplayer code.

## 5. Suggested API Surface

### Auth

```text
POST /api/auth/register
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/me
```

### Catalog

```text
GET /api/catalog
GET /api/catalog/{gameId}
```

### Library

```text
GET    /api/library
POST   /api/library/{gameId}/install
DELETE /api/library/{gameId}
```

### Launch

```text
POST /api/library/{gameId}/launch
POST /api/console/launch
GET  /api/launch/{sessionId}
```

### Runtime Filesystem

```text
POST /api/fs?session={launchSessionId}
```

### Future Multiplayer

```text
POST /api/rooms
POST /api/rooms/{roomId}/join
POST /api/rooms/{roomId}/launch
WS   /ws/ipx/{roomId}
```

## 6. Implementation Priorities

Build in this order:

```text
Identity
  -> user drive isolation
  -> catalog model
  -> install
  -> library UI
  -> generic launch
  -> DOS console
  -> multi-user validation
  -> expand catalog
```

Do **not** begin with the visual catalog.

The most important dependency is changing filesystem authorization from a global demo drive to an authenticated per-user drive. If that boundary is correct, the rest of the application can safely build on it.

## 7. Definition of Done for the Next Build Phase

The platform is ready to leave the initial implementation phase when:

- at least two users can sign in
- users have independent C: drives
- catalog entries are metadata-driven
- Commander Keen is installed from the catalog rather than pre-seeded into a global drive
- multiple catalog games can be installed and launched without game-specific code changes
- game state persists in each user's space
- a user can open a DOS prompt and interact with that same space
- automated tests prove cross-user filesystem isolation
- the architecture still exposes a clean future IPX networking seam

At that point the project is no longer a remote-filesystem prototype. It is a functioning single-player DOS gaming platform that can move through the later talk stages: testing, security, deployment, operations, documentation, and change.
