# ADR 0003: Metadata-Driven Launch Sessions

Status: Accepted

## Decision

Game launch behavior comes from catalog metadata. A short-lived launch session binds the authenticated user, game, launch mode, and configuration.

The generic runtime page uses that session to generate DOSBox configuration and AUTOEXEC commands.

## Rationale

Hard-coding Commander Keen would make every additional title a code change. Metadata-driven launch turns the emulator page into a reusable platform component.

## Consequences

- manifests become a versioned contract
- launch sessions require expiration and authorization
- filesystem access can be scoped through the same server-side launch-session record
