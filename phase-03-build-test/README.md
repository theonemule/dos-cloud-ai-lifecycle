# DOS Cloud — Phase 3 Build and Test

Phase 3 turns the remote-filesystem prototype into a multi-user browser DOS gaming platform.

## Run

    npm install
    npm run seed
    npm start

Open:

    http://10.0.1.183:8080

## Demo accounts

All demo users use password `doscloud`.

| User | Preinstalled demo library |
| --- | --- |
| alice | Commander Keen 1, DOOM |
| bob | Wolfenstein 3D, Duke Nukem |
| carol | Duke Nukem 3D, Raptor |
| dave | Secret Agent, Blake Stone |
| erin | Wacky Wheels, Cosmo's Cosmic Adventure |

The server also supports registering additional accounts. Each user gets a separate server-authoritative DOS C: drive.

## What works

- browse a 15-title shareware catalog
- install a title server-side into the logged-in user's `C:\GAMES`
- launch installed games in a new browser DOSBox tab
- use manifest-driven DOSBox settings and launch commands
- preserve game saves, scores, configuration, and filesystem changes in that user's drive
- open a generic DOS console against the same C: drive
- run multiple accounts without sharing files or library state
- bind REMOTEFS access to authenticated short-lived launch sessions

## Tests

    npm test
    npm run test:e2e
    npm run test:all

The browser suites have verified real execution of Commander Keen, DOOM, Wolfenstein 3D, and Duke Nukem 3D through the same generic runtime.

See:

- `docs/architecture.md`
- `docs/plan.md`
- `docs/catalog.md`
- `docs/test-report.md`
- `docs/adrs/`
