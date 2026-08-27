---
'@bee-agent/knowledge': minor
'@bee-agent/bee': minor
---

Add the WorldModel foundation (Phase 4 WF4-D): world entities, provenance-
carrying relations, and versioned snapshots in knowledge, with a serialized
`world` Chronicle stream whose version bumps carry a digest of the full
projected state — rebuilds verify every digest and fail loud on drift. A
sourced `WorldProjector` seam derives facts only from Chronicle events (the
bundled `ThreadToolProjector` records agent-to-tool usage with exact item
provenance); unevidenced assertions cannot enter the model. The Host now
maintains the projection (catch-up replay at start plus live append
projection) and serves a read-only `GET /world` view with kind/type/entity
filters.
