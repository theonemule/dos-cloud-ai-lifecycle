# Phase 5 — Operate, Document, and Review

Status: complete implementation snapshot

Phase 5 is forked from the completed Phase 4 Test and Secure snapshot.

This phase covers the final lifecycle stages used in the conference demo:

    Build -> Test -> Secure -> Operate -> Document -> Review

The product behavior from Phase 4 remains intact. Phase 5 adds the operational and deployment surface around it.

## Operate

Implemented:

- structured JSON application logging
- console logging suitable for container collection
- optional RFC5424-style syslog output over UDP
- request correlation IDs
- request duration and status logging
- authentication, OIDC, install, launch, and filesystem failure events
- automatic redaction of password, token, secret, authorization, and cookie fields
- liveness endpoint at /health
- readiness endpoint at /ready
- graceful SIGTERM and SIGINT shutdown
- Docker image and Docker Compose configuration
- Azure Container Apps Bicep deployment
- Azure Files persistent state mount
- Log Analytics integration
- Key Vault storage for the OIDC client secret
- managed identity for ACR image pulls and Key Vault access
- deployment helper that registers the generated Container Apps OIDC callback with the existing Entra app registration

## Document

Phase 5 adds documentation for:

- application architecture and data model
- local Node execution
- Docker execution
- operational logging and troubleshooting
- backup and recovery
- Azure Container Apps deployment
- common operational procedures
- security and scale limitations

## Review

The review document captures what is now production-shaped, what remains demo-oriented, and the next architectural changes required for scale.

The most important remaining constraint is SQLite on a network-mounted Azure Files share. The Azure deployment intentionally runs exactly one application replica. Scale-out should first move relational/session metadata to a managed database.

Previous phases remain frozen lifecycle snapshots.
