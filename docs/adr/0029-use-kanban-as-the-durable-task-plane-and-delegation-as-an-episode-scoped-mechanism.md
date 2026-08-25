# ADR 0029: Use Kanban as the Durable Task Plane and Delegation as an Episode-Scoped Mechanism

## Background

v0's `TaskRuntime` was a one-shot state machine: a task lived for the duration of a single run and its approval state vanished on restart. The v1 architecture (§15) needs cross-time and background work — scheduled, dependent, and recoverable across restarts — without letting a conversation's transient state masquerade as a durable task.

## Decision

Kanban is the single durable task plane. Every cross-time unit of work is a `KanbanTask` with a state machine (`inbox → triaged → ready → running → blocked/review → done`, plus `failed`/`cancelled`/`archived`), a claim lease, expected-version concurrency, and Chronicle-backed persistence; the embedded dispatcher owns claim/lease/heartbeat, timeout reclaim, dependency/time/priority scheduling, and idempotent retry. Each task records its source Thread/Turn and originating Item, so the two are bidirectionally traceable in one hop. Subagent delegation stays an Episode-scoped, bounded mechanism: a parent Episode may fan out to subagents for parallel or specialized work, but anything that must continue across turns is written back as a Kanban task rather than spawning unbounded background agents.

## Reasons

Thread manages interaction, Kanban manages durable work, and delegation manages a single Episode's bounded parallelism — one plane per concern, with no overlap. Durability and claim/lease semantics are exactly what background work needs to survive a crashed worker or a restart, and the explicit state machine plus expected-version concurrency prevents two workers from silently double-claiming a task.

## Alternatives

Keep tasks inside the Thread (no scheduling, no recovery, conversation state is not a task); keep a v0-style one-shot runtime (loses cross-time work); or let subagents spawn unbounded background work (no single task plane, no claim/lease, runaway fan-out).

## Positive impact

Tasks survive restarts and worker crashes; the dispatcher provides claim/lease/heartbeat and timeout reclaim; Thread↔Task links make provenance a one-hop query; CLI, Web, Scheduler, and agent tools all read and write the same store.

## Negative impact

A durable board adds a triage step and more moving parts than a one-shot run; the state machine's ordering means a task is only runnable once it reaches `ready`, which a caller must arrange.

## Follow-up constraints

Every task mutation is guarded by expected-version and persisted as a Chronicle event; the dispatcher alone owns claim/lease/heartbeat; subagent delegation is bounded to the parent Episode and any cross-turn continuation must be written back as a Kanban task.
