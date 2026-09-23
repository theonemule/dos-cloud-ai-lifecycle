# Phase 3 Test Report

Status: passing

## Automated Node tests

The Node test suite validates:

1. DOS-style case-insensitive filesystem behavior
2. path-traversal rejection
3. 15-game catalog and five seeded demo users
4. per-user install/filesystem isolation
5. metadata-driven launch for multiple packages
6. DOS console launch configuration
7. persistent save/high-score-style writes in only the owning user's C: drive
8. launch-session ownership for filesystem RPC
9. package checksums and declared launch commands
10. new-user registration with an independent empty library
11. rejection of unauthenticated catalog/filesystem requests
12. installation and launch metadata for every catalog package

## Browser end-to-end test

`test/browser-smoke.mjs` runs against the real web application and verifies:

- login as a seeded user
- Netflix-style catalog rendering
- game installation when needed
- launch-session creation
- generic runtime page
- DOSBox startup
- actual Commander Keen execution (`KEEN1`)

## Multi-game browser test

`test/multi-game-browser.mjs` proves that the same catalog/install/runtime path starts multiple game engines without game-specific server code:

- Commander Keen 1 -> `KEEN1`
- DOOM -> `DOOM`
- Wolfenstein 3D -> `WOLF3D`
- Duke Nukem 3D -> `DUKE3D`

## Isolated E2E runner

Run:

    npm run test:e2e

The script starts Phase 3 on a temporary state directory and separate port, runs both browser suites, and deletes the temporary database/user drives afterward.

For the full suite:

    npm run test:all

## Runtime stability regression

After reproducing the browser failures seen with the initial runtime, Phase 3 now uses:

- DOSBox-X as the browser backend
- the js-dos canvas renderer rather than WebGL
- a fixed 4:3 render aspect and viewport

The multi-game browser suite now keeps Commander Keen, DOOM, Wolfenstein 3D, and Duke Nukem 3D running for 25 seconds and fails if the runtime surface reports a backend crash or memory-access-out-of-bounds condition.

All four pass that extended check.

## Catalog visuals

Each of the 15 catalog manifests now references a local game screenshot. Screenshot provenance is recorded in the manifest and the image is served locally with the application, so catalog rendering does not depend on third-party image hosts at runtime.
