# ADR 0017: Position Bee Agent as a Personal Super Agent

## Background

v0.11 is a modular task runtime: one-shot tasks, a policy engine, pluggable storage, and adapters around a Cordis kernel. The v1 research pass (DeepSeek Harness, Hermes, Codex, Claude Code, Honcho — see `docs/architecture/bee-agent-v1.0.0-architecture-upgrade.md`) concluded that the product should not grow into an enterprise agent platform, nor stay a coding-only agent, but become one agent a single person lives with over time.

## Decision

v1.0.0 repositions Bee Agent as a **Personal Super Agent**: local-first, single-user by default, one process by default, with reasonable defaults out of the box and advanced capabilities enabled as plugins. The user always faces exactly one agent with one root Profile named `bee`, one continuous Thread, and one memory; coding, research, writing, and co-work are Skills/Tools/Plugins resolved per task, never Profiles to switch between. Cross-time work lives on a durable Kanban plane instead of inside conversations, and background learning improves the agent under explicit autonomy levels without ever widening its own permissions.

## Reasons

The four qualities only a personal agent can optimize together — trivially simple first use, growing understanding of one person over time, competence on complex tasks, and trustworthy real-world execution — are the acceptance bar for every v1 module; a platform positioning would trade them for tenancy, org flows, and fleet operations that a single owner never uses.

## Alternatives

An enterprise/multi-tenant agent platform (explicitly out of scope), a coding-first CLI agent (too narrow for personal automation and memory), or keeping the neutral task-runtime positioning (drifts toward feature accumulation without a product spine).

## Positive impact

A single product narrative ("one agent that knows you") replaces feature-by-feature growth; Thread continuity, Kanban durability, personal memory, and governed self-improvement all follow from it; the module admission check ("simpler, smarter, or safer?") becomes decidable.

## Negative impact

Multi-tenant, org-level, and cluster-orchestration requests become wontfix; some v0 capabilities (profiles-era assumptions, one-shot task API) lose their product justification and will be removed rather than preserved.

## Follow-up constraints

Thread–Turn–Item is the only client-facing protocol; internal models (Goal, World, Trajectory) stay progressive-disclosure; every release candidate is judged by the four qualities above; the security posture follows `docs/architecture/bee-agent-v1.0.0-threat-model.md`.
