# ADR 0002: Immutable Catalog Packages with Server-Side User Installation

Status: Accepted

## Decision

Catalog packages are immutable curated artifacts. Installing a title copies or extracts that package server-side into the authenticated user's C: drive.

## Rationale

This keeps catalog content controlled while giving each user's DOS game a normal writable directory. It also removes the browser from the package transfer path and avoids game-specific save adapters.

## Consequences

- install operations need archive validation and checksum verification
- package storage and user storage are separate
- duplicate per-user binaries are accepted initially for simplicity
- updates/reinstall behavior must be explicit rather than silently overwriting user state
