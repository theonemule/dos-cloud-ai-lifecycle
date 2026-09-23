# DOSBox / Emscripten integration

## Current approach

The js-dos DOSBox WebAssembly backend exposes the Emscripten filesystem used by DOSBox's normal local-drive implementation.

The prototype injects a custom Emscripten filesystem named REMOTEFS into the vendored wdosbox.js runtime and mounts it at /remote.

DOSBox then uses:

    MOUNT C /remote

From DOSBox's perspective it is an ordinary local directory. REMOTEFS translates filesystem operations into synchronous HTTP RPC calls from the DOSBox Web Worker.

## Why this works on LAN HTTP

Synchronous XMLHttpRequest is permitted in a Web Worker.

That means a DOS read can block the emulator worker until the backend responds without blocking the browser's main UI thread. No SharedArrayBuffer or secure browsing context is required.

## Mapping

Node operations:
- lookup -> stat
- getattr -> stat
- mknod -> create / mkdir
- readdir -> list
- rename -> rename
- unlink -> unlink
- rmdir -> rmdir
- setattr(size) -> truncate

Stream operations:
- open -> open
- read -> read
- write -> write
- llseek -> seek
- close -> close

## Server-side sessions

HTTP requests are independent, but DOS file handles are stateful. REMOTEFS generates a session ID and includes it with each request.

The backend keeps a DriveStore and handle table for that session so an open on one request can be followed by reads, seeks, writes, and close operations on later requests. Idle sessions are cleaned up automatically.

## Other transport

The WebSocket filesystem endpoint remains available for the diagnostic browser client. It is not required by DOSBox REMOTEFS anymore.
