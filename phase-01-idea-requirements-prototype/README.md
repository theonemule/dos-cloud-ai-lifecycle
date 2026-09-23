# DOS Cloud prototype

A feasibility spike for a browser-hosted DOS environment with a server-authoritative C: drive.

Commander Keen Episode 1 runs in js-dos/DOSBox in the browser, while its executable, game data, score files, and DOS-created files are read and written through a WebSocket filesystem service on the backend.

## Run

    npm install
    npm start

Then open:

    http://10.0.1.183:8080

The server listens on port 8080 by default.

## What is implemented

- Commander Keen Episode 1 shareware
- js-dos 8.4.1
- remote C: mounted as /remote inside the DOSBox worker
- synchronous HTTP filesystem RPC from the DOSBox worker
- open/read/write/seek/close
- stat and directory enumeration
- create/truncate/mkdir/rmdir/unlink/rename
- case-insensitive DOS path handling on Linux
- path traversal protection
- live filesystem traffic display
- explicit Commander Keen keyboard controls
- DOS-originated write proof during AUTOEXEC
- Node integration tests
- headless Chrome end-to-end smoke test

## Tests

    npm test
    npm run test:browser

The browser test expects the prototype server to already be running on localhost:8080 and Google Chrome to be installed at /usr/bin/google-chrome.

## Architecture

See docs/architecture.md and docs/dosbox-integration.md.

The next planned feature is an IPX-over-WebSocket relay using js-dos's injectable networking abstraction. WebSockets remain appropriate for IPX even though the filesystem now uses synchronous HTTP RPC.

## LAN access

The emulator filesystem is supported over ordinary LAN HTTP. It does not require HTTPS, SharedArrayBuffer, cross-origin isolation, or special Chrome flags. The /api/fs endpoint also returns CORS headers for cross-origin API use.
