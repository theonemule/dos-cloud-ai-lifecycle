# ADR 0004: Modular Monolith for the Initial Platform

Status: Accepted

## Decision

Implement authentication, catalog, library/install, launch sessions, filesystem access, and telemetry as modules inside one Node application.

## Rationale

The project is a conference demonstration and early platform. Independent microservices would add deployment and operational complexity without providing useful separation at this stage.

Logical boundaries still matter because the future IPX relay may have different scaling and networking characteristics.

## Consequences

- one primary server deployment
- one process can initially host control-plane APIs and filesystem APIs
- modules must avoid direct cross-module storage access where practical
- future extraction remains possible if workload characteristics justify it
