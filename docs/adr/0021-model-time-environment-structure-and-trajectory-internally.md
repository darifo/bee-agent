# ADR 0021: Model Time, Environment, Structure, and Trajectory internally

> Status: Accepted and implemented
>
> Date: 2026-08-27

## Context

A personal agent that runs for weeks needs trustworthy internal models of
four things: when facts were true (bi-temporal time), what its environment
looks like (files, tools, capabilities), which structure it ran under, and
why a Turn unfolded the way it did. Model-generated assertions are not
evidence; a world model that accepts them becomes an unauditable belief
store, and copied trajectory records drift from what actually happened.

## Decision

Chronicle is the temporal source of truth: dual `eventTime`/`ingestTime`,
`validTime` on durable facts, and logical `sequence` per stream govern
ordering — never wall-clock comparisons alone.

- The **WorldModel** is a versioned projection over a serialized `world`
  stream. Facts enter only through sourced `WorldProjector`s that cite the
  exact Chronicle position they were derived from; unevidenced assertions
  have no code path in. Every version bump carries a digest of the full
  projected state, and rebuilds verify each digest or fail loud.
- The **StructureGraph** replays the `structure` stream into a lineage view:
  every resolved version, its full phase history, its supersession chain,
  and the digest that ran last. Self-structure is observed like any other
  structure.
- **Trajectories** are causal index views, never copies: `buildTurnTrajectory`
  joins thread items, model-request streams, and execution streams; the exact
  model-visible context of any request replays digest-verified from sources
  plus renderers.

## Consequences

- Restart either rebuilds exactly the same world and history or fails with a
  drift error; there is no silently divergent projection.
- World and trajectory surfaces are read-only views over durable facts.
- New environment observations (worktrees, MCP servers, remote devices) are
  new projectors, not new fact stores.
- Comparisons and audits cite stream positions, so any answer can be traced
  to the events that produced it.

## Verification

World digest verification throws on replay drift (including a
subtype-loss regression caught during development); projector outputs carry
exact provenance; StructureGraph lineage replay covers supersession,
activation failure, and restart-required phases; the trajectory test runs a
real tool-using Turn and asserts generations (structure version, input
digest, usage), tool decisions from execution streams, checkpoints, and the
digest-verified model replay.
