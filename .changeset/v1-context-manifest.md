---
'@bee-agent/context': minor
---

Land the Context Manifest (architecture §10.3). `buildContextManifest` records a model call's input as sections with source ids, renderer version, priority, a token estimate, and a content digest; `rebuildContextInput` renders each section from its source + renderer and re-checks the digest, throwing `ContextReconstructionError` on drift. `context.manifest` events persist the manifest into Chronicle keyed to the thread/turn/structure version. Token estimation is a deterministic characters-over-four stand-in until Phase 2 swaps in a real tokenizer.
