---
'@bee-agent/kernel': minor
---

Formalize reversible effects and the plugin lifecycle. New `EffectScope` registry releases disposers in reverse registration order, keeps releasing after failures, and reports every failure; `TaskScope.onDispose` now runs through it and `TaskScope.dispose`/`Kernel.disposeTaskScope` are async. `Kernel.stop` tears down task scopes and plugins in reverse creation/mount order. Plugins may implement optional `drain` (quiesce with timeout report) and `healthCheck` hooks, exposed on every `PluginHandle` with sensible defaults. A failed unload quarantines the handle (`status: 'quarantined'`), records it on the kernel (`quarantinedPlugins`, `restartRequired`, `plugin-quarantined` event), never retries the failed cleanup, and refuses remounting the same plugin id until restart.
