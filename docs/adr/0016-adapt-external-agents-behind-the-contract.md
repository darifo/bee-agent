# ADR 0016: Adapt external agents behind the contract

> Status: Superseded by the v1 clean break. The former CommandAgent and
> RemoteAgent implementations were deleted; replacements must preserve the
> Thread–Turn–Item protocol and route effects through ExecutionWorld.

## Background

The `Agent` contract so far has in-process implementations (mock, OpenAI-compatible chat); the roadmap's last mile is reaching agents outside this process — other Bee Agent servers and arbitrary command-line programs.

## Legacy decision (v0)

Add `adapters/agents` (`@bee-agent/agent-adapters`) with two adapters behind the existing `Agent` contract: `RemoteAgent` delegates a run to another Bee Agent server through the Client SDK (create → run → stream → final snapshot), mirrors remote `agent.message` events into the local event log, and propagates local cancellation to the remote task; `CommandAgent` wraps any executable — the task input arrives via a `{input}` argv placeholder or stdin and the program's stdout becomes the reply — with timeouts, env control, and error mapping. The composition root registers either via `buildServer({ agents })`; `BEE_AGENT_COMMAND_AGENTS` (a validated JSON array) configures command agents from the environment.

## v1 direction

No external-agent adapter is currently registered. Local harness delegation
must be Episode-scoped and bounded by depth, concurrency, budget, world scope,
generation lease, and trajectory lineage. A remote transport additionally
requires an enforcing network provider and explicit schema/redaction/
permission translation; it may not reuse unrestricted Host HTTP access.

## Reasons

Both adapters reuse proven seams — the Client SDK for federation, one-shot child processes for programs — so task runtimes, policies, event sourcing, and approvals work unchanged; agent ids stay the single addressing mechanism for task specs; the `{input}`/stdin contract covers wrapper scripts around any external agent binary without a shell.

## Alternatives

A2A-style protocol adapters (spec churn for a preview), long-lived worker processes (state leaks), or building federation into the kernel (it is an agent concern, not a kernel service).

## Positive impact

Servers can federate work to specialized deployments, and existing CLI agents become first-class `agentId`s usable by any model, the CLI, and the Web console; cancellation and error semantics match local agents.

## Negative impact

Remote runs mirror messages only after the remote task finishes (no live streaming yet); command agents inherit the process's privileges — same trust posture as the Python tool; per-run process cost applies.

## Follow-up constraints

Live streaming federation streams events as they arrive instead of replaying; remote transports stay on the supported REST + SSE API; command agents never spawn through a shell.
