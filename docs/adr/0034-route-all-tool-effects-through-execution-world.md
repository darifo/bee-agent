# ADR 0034: Route all tool effects through ExecutionWorld

- Status: Accepted and implemented (core pipeline plus Command/Python/MCP)
- Date: 2026-08-26

## Context

The Phase 1 `AgentLoopToolSlot` let a tool execute directly and decide for itself whether approval was required. That mixed policy with implementation, provided no durable execution identity, and made a crash after an external side effect indistinguishable from a call that never started. Model-generated approval titles also did not prove which concrete paths, commands, targets, secrets, or effects would be used.

## Decision

Remove `AgentLoopToolSlot`. A `ToolExecutor` now has two responsibilities only: `describe()` expands a model tool intent into an authoritative capability, resource requirements, expected effects, and verification plan; `execute()` performs an already-authorized action.

The tier-B ToolExecution plugin converts the description to a validated `ActionRequest` and routes it through `ExecutionWorld`. Authorization is deny-by-default. An `ask` decision creates the existing durable Thread Approval Item from ExecutionWorld's canonical action detail; only an approved resume reaches the sandbox executor.

Every action uses a stable idempotency key and an independently addressed Chronicle stream. Completed results replay without execution. Reusing a key for a different request fails. A stream containing `execution.started` without a completed result is marked `reconciliation-required`; Bee must not blindly repeat an unknown external effect.

Sandbox providers report which filesystem, network, and process restrictions they can enforce. The built-in in-process provider is only for logical tools. A request-scoped router sends commands, path access, network declarations, and secrets to the platform provider while retaining provider ownership across snapshot/diff.

The first platform provider uses macOS Seatbelt or Linux bubblewrap. It probes whether isolation can actually be activated, uses no implicit shell, starts from an empty environment, terminates the detached process group on cancellation/timeout/output overflow, and fails closed when a requested boundary cannot be enforced. A macOS Keychain broker resolves `keychain:<service>/<account>` references only after authorization; only explicitly mapped `secretEnv` values reach the child process and all materialized values are redacted before persistence.

## Consequences

- AgentLoop no longer owns tool authorization or direct execution.
- Tool plugins must provide concrete declarations; undeclared capabilities are denied.
- Approval text is derived from the expanded action, not from model prose.
- Logical Kanban tools remain in process; command, Python, MCP, browser, and remote-agent adapters must declare resources so routing selects an enforcing provider.
- The first migrated external adapter is `command_run`: it accepts only Host-allowlisted native executables, confines declared paths to one canonical workspace, defaults to `ask`, and throws if anything attempts to invoke its in-process `execute()` path.
- Network allowlists, recursive filesystem diffs, non-macOS credential stores, and adapter migration remain Phase 3 deliverables. Until then their requested capabilities fail closed.
- Imports of `child_process` outside `@bee-agent/execution` are rejected by static package-boundary checks.
