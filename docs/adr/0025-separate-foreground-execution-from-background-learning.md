# ADR 0025: Separate foreground execution from background learning

> Status: Accepted and implemented
>
> Date: 2026-08-31

## Context

Learning needs cross-task aggregation, heavy retrieval, evaluation, and
experiments on a time scale of minutes to days. Running it inside the
AgentLoop would raise per-turn token cost and latency, leak unvalidated
conclusions into the current task, make it impossible to pause/replay or
give learning its own compute, and conflate "finished this task" with
"became better" (architecture §11.1).

## Decision

Learning is a separate module (`packages/learning`) on a background cadence
with its own budget, not a step in the AgentLoop:

- The slow loop reads **durable facts only** (Chronicle trajectories,
  projections) and writes **ImprovementProposals only** — it has no path
  that mutates memory, structure, tools, or behavior directly.
- Each pass is budgeted (trajectory cap, per-run proposal cap) and appends
  a durable `learning.loop.run` audit fact, so even quiet runs are visible.
- Evaluation runs against digest-pinned frozen datasets inside
  ExperimentWorld; the foreground loop is never involved.
- Activation of an approved change happens through governed host channels
  (today the memory provider, whose claims the recall hook injects), never
  from inside the learning module.
- The Host composes both rhythms: turns run on the fast loop, the slow loop
  and drift monitoring ride an interval timer with manual triggers
  (`POST /learning/run`, `POST /learning/monitor`).

## Consequences

- The AgentLoop stays lean; learning can be paused, replayed, re-modelled,
  or moved to a worker without touching foreground semantics.
- Proposals are the only interface between the two rhythms, which keeps the
  seam auditable and testable.
- A crashed or slow learning pass cannot break a conversation; a busy
  conversation cannot rush an experiment.
- Learning latency to improvement is deliberately longer than
  in-context "learning" — the trade for evidence, governance, and
  reversibility.

## Verification

The learning package tests run the loop over real Chronicle trajectories;
host integration tests run conversations and the loop side by side; the
Phase 5 exit demonstration drives the full arc on a live Host with a real
model.
