# ADR 0010: Define the REST and SSE server API

> Status: Replaced for v1 by the Thread–Turn–Item and Kanban APIs. The v0
> `/tasks` runtime and global approval endpoints were deleted in the clean
> break.

## Background

ADR 0003 chose REST commands plus sequence-addressed SSE and required clients
to use a shared SDK. v1 subsequently replaced the one-shot TaskRuntime with a
conversation protocol and separated durable background work into Kanban.

## v1 decision

The Fastify composition root is `@bee-agent/bee`; `@bee-agent/client` remains
the supported client boundary.

- `POST /threads` creates a Thread.
- `POST /threads/:threadId/turns` runs a Turn through the generation-pinned
  AgentLoop.
- `POST /threads/:threadId/turns/:turnId/approvals/:approvalId` records a
  decision and resumes the suspended Turn.
- `GET /threads/:threadId/items` is the replay-then-live SSE Item stream and
  accepts `Last-Event-ID` or `?after=`.
- `/kanban/tasks` and task-specific update/block/comment/complete/cancel routes
  expose the durable task plane.
- `GET /structure` and `POST /structure/reconcile` expose local structure
  inspection and reconciliation.
- `GET /health` is the only route exempt from session-token authentication.

The Host binds to loopback by default, applies a loopback-only CORS policy, and
rejects non-loopback binding without an explicit session token. Errors use the
shared envelope and route handlers remain thin over domain/runtime services.

## Reasons

Thread owns user interaction, Kanban owns cross-time tasks, and Chronicle
sequences make replay and live delivery one transport. Approval identity is
scoped to the suspended Turn instead of a global in-memory inbox.

## Consequences

Old `/tasks`, `/approvals`, task snapshots, task event names, and the
`@bee-agent/server` package are not compatibility surfaces. CLI and Web must
use `@bee-agent/client`, including for authentication and SSE resume.
