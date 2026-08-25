---
'@bee-agent/kernel': minor
---

Add tiered hot replacement (architecture §9.3). Plugins declare a `replacementTier` on their mount options (`a` swaps only with no call in flight, `b` defers to the Turn boundary, `c` refuses hot replacement), and `ReplacementCoordinator` enforces the boundaries: `beginTurn` pins a structure version, `endTurn` drains then applies deferred B-tier replacements in order, and a running Turn's pinned structure version is never changed by a replacement.
