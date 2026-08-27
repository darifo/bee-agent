# ADR 0027: Default to an embedded single-host runtime with optional remote adapters

> Status: Accepted and implemented
>
> Date: 2026-08-27

## Context

Bee Agent is a personal super agent for one user: local-first by
positioning. The v0 lesson was that defaulting to PostgreSQL plus pgvector
meant every user deployed a database before their first conversation. At the
same time, models, memories, and tools legitimately live behind remote
services, so remoteness must be an adapter concern, not an architectural
assumption.

## Decision

The default Host is a single embedded process:

- **Storage** is SQLite (WAL) — Chronicle and Kanban over one file — inside
  the unified personal data directory: `BEE_AGENT_DATA_DIR` or the platform
  convention (macOS Application Support, XDG data home). No database
  service, no vector store.
- **Memory** is the embedded memory-bee provider; **scheduling** is the
  in-process durable AgentScheduler; **world projection** runs in the Host
  over its own Chronicle streams.
- Everything remote is an opt-in adapter behind a local contract:
  OpenAI-compatible model providers, remote memory through memory-remote's
  HTTP transport (ADR 0024), RemoteAgent through an exact-origin network
  sandbox (ADR 0023), MCP servers through Host-pinned manifests. Remote
  adapters degrade explicitly; the local Chronicle remains the fact base.
- Security defaults match the embedded form: loopback bind, session token
  guard, loopback-only CORS.

## Consequences

- A new user needs one model endpoint and nothing else to run the Host; all
  durable artifacts live in one predictable personal directory that backs up
  and exports as a unit.
- Single-writer-per-stream serialization assumptions hold in the embedded
  form; multi-device or remote-worker topologies require explicit adapters,
  not silent shared stores.
- PostgreSQL remains a possible future adapter, never a default dependency.
- The daemon/tray packaging form is a distribution concern layered on this
  same single process (Phase 6 scope).

## Verification

The Host test suite boots complete servers with no external services beyond
a scripted model runtime; data-directory resolution covers explicit,
macOS, and XDG cases; the remote-memory switch and its outage behavior are
asserted against the durable stream; loopback/token defaults are covered by
the security suite.
