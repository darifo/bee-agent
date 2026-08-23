# ADR 0010: Define the REST and SSE server API

## Background

ADR 0003 chose REST commands plus SSE streaming and required clients to go through a Client SDK. The concrete resource model, status codes, and resume semantics were still undefined.

## Decision

Serve a small REST + SSE surface from the Fastify composition root (`@bee-agent/server`), with `@bee-agent/client` as the only supported client:

- `POST /tasks` (201) creates a task; `GET /tasks/:id` (200) returns the replayed snapshot; `POST /tasks/:id/run` (202) starts the run in the background and returns the snapshot after the run began; `POST /tasks/:id/cancel` (200) cancels; `GET /tasks/:id/events?after=` (200) lists recorded events.
- `GET /approvals?taskId=` (200) lists pending requests; `POST /approvals/:requestId/decision` (200) decides one and resumes the task.
- `GET /tasks/:id/events/stream` is an SSE channel: recorded events after `Last-Event-ID` (or `?after=`) are replayed first, then live events follow; `id` is the event sequence, `event` is the event type, `data` is the full event JSON. The server closes the stream at a terminal state and sends heartbeat comments.
- Errors use the shared error envelope with mapped statuses: unknown task/approval 404, invalid state or concurrent run 409, validation failures 400.

## Reasons

REST + sequence-addressed SSE reuses the append-only event stream as the transport: replay and live delivery are the same mechanism, and reconnects resume exactly where the client stopped.

## Alternatives

WebSocket, JSON-RPC, or polling snapshots.

## Positive impact

The CLI and future Web UI share one SDK; the API is testable without a browser; resume works across restarts because sequences are durable.

## Negative impact

No client-to-server streaming; SSE requires connection-per-task for live updates.

## Follow-up constraints

Do not add transport features outside the Client SDK; keep handlers thin (validation + runtime calls) so business rules stay in the runtimes; the run route must surface pre-start failures (for example 409) instead of silently timing out.
