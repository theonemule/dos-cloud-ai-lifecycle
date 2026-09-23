# DOS Cloud spike architecture

## Goal

Run a DOS game in the browser while making the backend filesystem the authoritative C: drive.

This is not a synchronization system. There is no dirty-file upload step and no disk-image/block protocol. DOS filesystem operations are forwarded to the backend as they happen.

## Working topology

Browser main thread
- js-dos 8.4.1 UI/player
- filesystem telemetry UI
- WebSocket diagnostic client for the side panel

DOSBox Web Worker
- js-dos DOSBox WebAssembly backend
- custom Emscripten REMOTEFS mounted at /remote
- DOSBox mounts /remote as C:
- synchronous HTTP RPC to /api/fs

Backend
- Node HTTP/WebSocket service
- server-side filesystem sessions
- authoritative files under data/<drive>/

## Why synchronous HTTP is used

DOSBox and its C runtime expect synchronous filesystem calls. Browser WebSockets are asynchronous.

The earlier spike bridged that mismatch with SharedArrayBuffer and Atomics. That worked on localhost and HTTPS, but failed on ordinary LAN HTTP because SharedArrayBuffer requires a secure cross-origin-isolated context.

The current implementation removes that browser requirement entirely.

XMLHttpRequest is allowed to operate synchronously inside a Web Worker. REMOTEFS therefore performs a synchronous POST from the DOSBox worker for each filesystem operation. Only the emulator worker is blocked while the request completes; the browser UI remains responsive.

This works over plain LAN HTTP and does not require:
- HTTPS
- SharedArrayBuffer
- Atomics
- crossOriginIsolated
- browser launch flags

## HTTP filesystem protocol

Endpoint:

    POST /api/fs?drive=<drive>&client=emulator&session=<session>

Each request and response uses:
- 4-byte big-endian JSON-header length
- JSON header
- optional binary payload

The endpoint supports CORS and OPTIONS preflight.

The session identifier lets separate HTTP requests share server-side open file handles.

Implemented operations:
- open
- close
- read
- write
- seek
- stat
- list
- create
- truncate
- mkdir
- rmdir
- unlink
- rename

## DOS semantics

Implemented:
- authoritative server-side files
- persistence across browser sessions
- numeric POSIX/Emscripten open flags
- explicit-position reads and writes
- directory enumeration
- create/truncate/delete/rename
- case-insensitive DOS path resolution on Linux
- path traversal protection

## Commander Keen proof

AUTOEXEC performs:

    mount c /remote
    c:
    echo REMOTE DOS DRIVE READY>C:\REMOTEFS.TXT
    cd \KEEN
    KEEN1.EXE

The browser smoke test confirms KEEN1 is the running program, game assets are read from the backend, and DOS writes C:\REMOTEFS.TXT to backend storage.

The smoke test is intentionally run against the LAN IP over plain HTTP and verifies that secureContext, crossOriginIsolated, and SharedArrayBuffer are not required.

## WebSockets

WebSockets remain in the project for the diagnostic UI client and are still a good fit for the planned IPX relay. They are no longer used to implement synchronous DOS filesystem calls.
