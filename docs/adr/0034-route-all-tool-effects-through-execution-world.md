# ADR 0034: Route all tool effects through ExecutionWorld

- Status: Accepted
- Date: 2026-08-26

## Context

The Phase 1 `AgentLoopToolSlot` let a tool execute directly and decide for itself whether approval was required. That mixed policy with implementation, provided no durable execution identity, and made a crash after an external side effect indistinguishable from a call that never started. Model-generated approval titles also did not prove which concrete paths, commands, targets, secrets, or effects would be used.

## Decision

Remove `AgentLoopToolSlot`. A `ToolExecutor` now has two responsibilities only: `describe()` expands a model tool intent into an authoritative capability, resource requirements, expected effects, and verification plan; `execute()` performs an already-authorized action.

The tier-B ToolExecution plugin converts the description to a validated `ActionRequest` and routes it through `ExecutionWorld`. Authorization is deny-by-default. An `ask` decision creates the existing durable Thread Approval Item from ExecutionWorld's canonical action detail; only an approved resume reaches the sandbox executor.

Every action uses a stable idempotency key and an independently addressed Chronicle stream. Completed results replay without execution. Reusing a key for a different request fails. A stream containing `execution.started` without a completed result is marked `reconciliation-required`; Bee must not blindly repeat an unknown external effect.

Sandbox providers report which filesystem, network, and process restrictions they can enforce. The built-in in-process provider is only for logical tools and rejects requests needing any of those OS boundaries. Secret values are materialized after authorization, passed separately to the sandbox, and redacted from output, diff, and failures before persistence.

## Consequences

- AgentLoop no longer owns tool authorization or direct execution.
- Tool plugins must provide concrete declarations; undeclared capabilities are denied.
- Approval text is derived from the expanded action, not from model prose.
- Logical Kanban tools remain in process, while command, Python, MCP, browser, and remote-agent adapters must wait for or select an enforcing sandbox provider.
- Seatbelt, bwrap, process-tree cancellation, and a system-backed SecretBroker remain explicit Phase 3 deliverables; the in-process provider must never be presented as OS isolation.
