# ADR 0023: Route every capability through ExecutionWorld

> Status: Accepted and implemented
>
> Date: 2026-08-26

## Context

Tools, worktree management, delegated agents, and remote agents can all cause
effects. Separate executors would duplicate permission, approval, secret,
sandbox, cancellation, idempotency, and audit behavior and inevitably create
host-level bypasses.

## Decision

Every effectful capability is expanded into a canonical `ActionRequest` and
passes through one `ExecutionWorld`. Authorization is a durable monotonic
intersection of hard safety, active Structure grants, user grants, Bee policy,
plugin declarations, task scope, and the selected sandbox capability report.
The complete materialized snapshot is appended before approval or execution.

Logical tools may use the in-process sandbox only when they declare no OS or
network effects. Commands, Python, MCP stdio, Git worktrees, and RemoteAgent
calls select an enforcing provider. Worktree lifecycle operations are Git
actions inside ExecutionWorld. A RemoteAgent declaration contains no network
client; its request can run only through an exact-origin
`AllowlistedNetworkSandbox`. Episode delegation is bounded by depth,
concurrency, child count, time, token, cost, and world-action limits and
preserves parent/child trajectory lineage.

Secrets are late-bound by a system credential broker, injected minimally, and
redacted before Chronicle persistence. Artifact storage rejects content that a
materialized-secret scanner changes. macOS uses Keychain and Linux uses the
Freedesktop Secret Service. Unsupported enforcement fails closed.

## Consequences

- `child_process` remains forbidden outside `@bee-agent/execution`.
- A plugin cannot turn its declaration into authority; every permission layer
  must independently grant the capability.
- Remote network transports are Host-injected and receive only a reviewed
  origin and structured payload.
- Coding bundles can provision isolated worktrees without gaining a direct Git
  execution path.
- Linux CI installs bubblewrap and makes its real filesystem/process contract
  mandatory; macOS retains its Seatbelt contract.
- Cross-Turn work is Kanban-owned. Delegation is never an unbounded background
  task queue.

## Verification

The contract suite covers permission snapshot order, durable approval and
replay, symlink canonicalization, sandbox capability denial, exact network
targets, secret event/artifact leakage, worktree routing, bounded delegation,
RemoteAgent declaration/transport separation, and process-group cancellation.
