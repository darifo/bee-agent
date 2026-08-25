---
'@bee-agent/knowledge': minor
---

Record resolved structures in Chronicle. The new `structure.resolved` event type carries the full effective structure, its digest, and the bundle chain; the envelope's `structureVersion` field carries the digest so later events tie back to the structure they ran under. `appendResolvedStructure` writes to the `structure` stream, deduplicating unchanged digests (only actual structure changes create versions) and honoring explicit `expectedSequence` for caller-managed concurrency.
