---
'@bee-agent/knowledge': minor
'@bee-agent/memory-remote': minor
'@bee-agent/runtime': minor
---

Add explicit remote-memory degradation: a `memory.health.changed` Chronicle
event records every provider health transition; `MemoryProviderUnavailableError`
enables fail-fast calls; the new `@bee-agent/memory-remote` package provides
the bridge transport seam (with an in-process SDK bridge) and
`RemoteMemoryProvider` with a consecutive-failure circuit breaker whose
recovery runs through health probes. The recall hook now skips gracefully when
a circuit opens mid-call. Phase 4 CI gates land with this slice: conflicting
claims stay visible until corrected, a reference in-memory provider
self-validates the contract suite, and a fake-clock test covers weeks-later
recall with corrections and expired valid-time facts.
