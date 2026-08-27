---
'@bee-agent/memory-remote': minor
'@bee-agent/bee': minor
---

Finish the remaining Phase 4 foundations. The unified personal data
directory: durable Host artifacts now default to `BEE_AGENT_DATA_DIR` or the
platform convention (macOS Application Support / XDG data home) instead of
the working directory; explicit `BEE_AGENT_STORAGE_SQLITE_FILENAME` still
wins. The memory-remote HTTP transport: `FetchMemoryTransport` speaks a
documented `/memory/*` REST contract (query/ingest/context/representation/
derive/consolidate/retract/export/health) with bearer auth and explicit
`MemoryTransportError` status mapping; the Host switches to it — behind the
existing circuit breaker with durable health events — when
`BEE_AGENT_MEMORY_REMOTE_URL` is set. The transport is pinned by a
reference HTTP server test running the full wire round-trip.
