# ADR 0019: Use Thread–Turn–Item as the Public Interaction Protocol

## Background

v0 exposed a task/approval/memory API where the server's internal execution model (tasks, agents, tool results) was also the client contract. The v1 architecture research (Codex, §5.2) distinguishes a _simple interaction protocol_ that clients understand from a _rich internal execution model_ that stays progressive-disclosure. A conversation client should never need to learn about Goals, Plans, Episodes, or Steps.

## Decision

Thread–Turn–Item is the only public, client-facing protocol: `@bee-agent/thread` defines `Thread` (a long-lived relationship with a title, workspace, and memory view), `Turn` (one user input or system trigger to a stable boundary where control returns to the user), and `Item` (the streamable units inside a Turn — message, plan, tool call, approval, artifact, file change, memory citation, learning note). The host serves `POST /threads`, `POST /threads/:id/turns`, an approval endpoint, and `GET /threads/:id/items` over SSE with `Last-Event-ID` recovery. Internal objects (Goal, Plan, Kanban Task, Episode, Step) surface only as citations inside items, never as their own API.

## Reasons

A minimal, stable protocol is what makes CLI and Web clients cheap to build and keep in sync; every richer object adds client surface without adding what a conversation needs. One sequence per thread (contiguous, assigned by the Chronicle store) gives reconnecting clients a single cursor, so resuming after a disconnect cannot drop an item.

## Alternatives

Keep the task API as the contract (couples clients to the runtime's internal model and grows without bound); expose Goal/Plan/Episode directly (leaks the internal execution model into the client); or a fully generic event stream (clients must re-derive Thread/Turn/Item themselves, which defeats the point of a protocol).

## Positive impact

The client SDK, CLI, and Web stay small and stable; thread sequences make SSE recovery trivially correct; the protocol surface is finite and versioned independently of the execution engine.

## Negative impact

Clients cannot observe internal planning/reasoning unless it is deliberately materialized as an Item (a deliberate transparency cost, not an accident); the protocol fixes the unit-of-work vocabulary and resists ad-hoc additions.

## Follow-up constraints

Thread–Turn–Item remains the only client contract through Phase 6; new item types go through the protocol's schema registry and fail loud when unknown; Kanban Tasks are reachable from Items but never replace them as the conversation surface.
