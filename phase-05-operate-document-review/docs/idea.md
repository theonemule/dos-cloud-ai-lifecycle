# Phase 1 Idea

## Working concept

Build a small "Steam for DOS" style browser experience.

A DOS game runs in the browser through js-dos/DOSBox, but its C: drive is not a browser-local synchronized copy and is not a remote block device. The backend owns the filesystem. DOS filesystem operations are forwarded to that backend as ordinary file operations.

The first game is Commander Keen Episode 1 because it makes the prototype immediately recognizable and exercises real DOS executable, data, level, score, and configuration file access.

## Initial scope

Phase 1 is intentionally single-player.

The prototype needs to prove two things:

1. A DOS game can execute directly against a server-authoritative C: drive from a normal browser.
2. DOS can both read and write through that drive without a separate synchronization step.

A later feature will add an IPX networking overlay so multiple browser-hosted DOS instances can participate in the same multiplayer session.

## Why this project

The project is deliberately more interesting than a conventional CRUD application. It creates useful engineering questions around browser runtimes, legacy application expectations, filesystem semantics, network transports, security boundaries, infrastructure, testing, and eventually multiplayer networking.

That makes it a useful application to carry through the full AI-assisted software lifecycle in the conference talk.
