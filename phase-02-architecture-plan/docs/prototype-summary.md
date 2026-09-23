# Phase 1 Prototype Summary

Phase 1 produced a working browser DOS environment with a server-authoritative filesystem.

## Result

Commander Keen Episode 1 runs inside js-dos/DOSBox and mounts `/remote` as DOS drive C:.

The custom Emscripten REMOTEFS translates DOS filesystem calls into synchronous HTTP RPC from the DOSBox Web Worker to the backend. This design was chosen after an earlier WebSocket plus SharedArrayBuffer bridge worked on localhost but failed over ordinary LAN HTTP because SharedArrayBuffer requires a secure cross-origin-isolated browser context.

The current design has no such requirement.

## Working path

    Commander Keen
        -> DOSBox
        -> MOUNT C /remote
        -> Emscripten REMOTEFS
        -> synchronous HTTP RPC
        -> server-side DriveStore
        -> authoritative files

## Validated behavior

The automated browser test is run against the LAN IP using plain HTTP and verifies:

- Commander Keen is the running DOS program.
- the browser is not in a secure context.
- cross-origin isolation is not enabled.
- SharedArrayBuffer is unavailable.
- game data is still read successfully from the backend.
- a DOS-originated write reaches the backend.
- the controls and demo UI are present.

The Node integration suite validates filesystem behavior independently of the browser.
