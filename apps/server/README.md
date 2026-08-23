# Server

Fastify HTTP + SSE composition root for Bee Agent.

It starts the kernel, mounts the SQLite storage plugin under the standard
`event-store` and `storage` service keys, wires the task runtime with the
mock agent and the calculator tool, and serves the REST + SSE API from
[ADR 0010](../../docs/adr/0010-define-rest-and-sse-server-api.md).

## Run

```bash
pnpm --filter @bee-agent/server build
BEE_AGENT_PORT=3000 \
BEE_AGENT_HOST=127.0.0.1 \
BEE_AGENT_STORAGE_SQLITE_FILENAME=./bee-agent.sqlite \
pnpm --filter @bee-agent/server start
```

Environment variables: `BEE_AGENT_HOST` (default `127.0.0.1`),
`BEE_AGENT_PORT` (default `3000`), and
`BEE_AGENT_STORAGE_SQLITE_FILENAME` (default `bee-agent.sqlite`; use
`:memory:` for an ephemeral instance).

## API

| Method | Path                             | Behavior                                                    |
| ------ | -------------------------------- | ----------------------------------------------------------- |
| GET    | `/health`                        | Liveness probe                                              |
| POST   | `/tasks`                         | Create a task (201, `CreateTaskResponse`)                   |
| GET    | `/tasks/:taskId`                 | Replayed snapshot (200)                                     |
| POST   | `/tasks/:taskId/run`             | Start the run in the background (202, snapshot after start) |
| POST   | `/tasks/:taskId/cancel`          | Cancel the task (200, snapshot)                             |
| GET    | `/tasks/:taskId/events?after=`   | Recorded events (200)                                       |
| GET    | `/tasks/:taskId/events/stream`   | SSE: replay after `Last-Event-ID`/`?after=`, then live      |
| GET    | `/approvals?taskId=`             | Pending approval requests (200)                             |
| POST   | `/approvals/:requestId/decision` | Decide an approval and resume the task (200)                |

Errors return the shared error envelope; unknown ids are 404, invalid states
and concurrent runs are 409, validation failures are 400. Clients should use
`@bee-agent/client` instead of calling the API directly.
