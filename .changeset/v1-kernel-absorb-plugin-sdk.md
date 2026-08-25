---
'@bee-agent/kernel': major
---

Absorb the `@bee-agent/plugin-sdk` contract into the kernel (`PluginManifestSchema`/`BeeAgentPlugin` now live in `@bee-agent/kernel`) and drop the v0 `event-store`/`vector-store`/`storage` service keys. The kernel no longer imports any internal package.
