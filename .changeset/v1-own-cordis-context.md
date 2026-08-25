---
'@bee-agent/kernel': minor
---

Drop the `cordis` dependency and replace it with a minimal own `Context` (`packages/kernel/src/context.ts`). It reproduces only the surface the kernel uses — service slots (`get`/`set`), event listeners (`on`/`emit` that reach ancestors), reversible effects (`effect`), plugin forking (`plugin`), service isolation (`isolate` with shared realms), and `start`/`stop` — with the same semantics cordis provided for them, while leaving out the heavyweight traceable-proxy/inject/reactive-config machinery the kernel never used.
