# @bee-agent/memory-remote

## 0.2.0

### Minor Changes

- eacaf5e: Finish the remaining Phase 4 foundations. The unified personal data
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
- 6c62bd0: Add explicit remote-memory degradation: a `memory.health.changed` Chronicle
  event records every provider health transition; `MemoryProviderUnavailableError`
  enables fail-fast calls; the new `@bee-agent/memory-remote` package provides
  the bridge transport seam (with an in-process SDK bridge) and
  `RemoteMemoryProvider` with a consecutive-failure circuit breaker whose
  recovery runs through health probes. The recall hook now skips gracefully when
  a circuit opens mid-call. Phase 4 CI gates land with this slice: conflicting
  claims stay visible until corrected, a reference in-memory provider
  self-validates the contract suite, and a fake-clock test covers weeks-later
  recall with corrections and expired valid-time facts.

### Patch Changes

- Updated dependencies [34d0d4f]
- Updated dependencies [6c62bd0]
- Updated dependencies [e359897]
- Updated dependencies [7460bb1]
- Updated dependencies [149fddf]
  - @bee-agent/knowledge@0.2.0
