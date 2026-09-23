# Phase 1 Requirements

## Functional requirements

- Run a DOS game in a modern browser using js-dos/DOSBox.
- Use Commander Keen Episode 1 shareware as the initial game.
- Present a DOS-visible C: drive.
- Store the authoritative contents of C: on the server.
- Do not synchronize dirty files between browser storage and the server.
- Do not expose the filesystem as a block device or disk image protocol.
- Support open, close, read, write, seek, stat, directory listing, create, truncate, mkdir, rmdir, unlink, and rename.
- Preserve server-side file handles across related remote calls.
- Treat DOS paths case-insensitively even though the backend host filesystem is Linux.
- Prevent path traversal outside the configured drive root.
- Allow the application to work from another machine on the LAN over ordinary HTTP.
- Show filesystem telemetry so it is obvious game files are being read from the backend.
- Show Commander Keen keyboard controls clearly in the browser UI.

## Prototype proof points

The prototype is successful when:

- DOSBox mounts the remote filesystem as C:.
- Commander Keen becomes the running DOS program.
- Keen reads executable and game data through the remote filesystem.
- DOS can create and write a file through the same filesystem.
- Data remains on the backend rather than in a browser-local synchronization cache.
- The prototype works at the DevBox LAN address without HTTPS, browser flags, SharedArrayBuffer, or cross-origin isolation.

## Explicitly out of scope for Phase 1

- Multiple users
- Authentication and authorization
- Game catalog/storefront
- IPX multiplayer
- Quotas
- File locking and multi-writer conflict handling
- Snapshots/version history
- Production storage backend
- Production deployment architecture
- Production observability and alerting
