---
'@bee-agent/event-store': minor
'@bee-agent/plugin-storage-sqlite': minor
'@bee-agent/runtime': minor
'@bee-agent/client': minor
'@bee-agent/server': minor
'@bee-agent/cli': minor
'@bee-agent/web': minor
---

Added the React Web UI and the task-listing chain it needs.

- `@bee-agent/event-store`: `EventStore.listTaskIds()` enumerates every task with recorded events (oldest first).
- `@bee-agent/plugin-storage-sqlite`: implements `listTaskIds()` over the `task_sequences` table ordered by insertion.
- `@bee-agent/runtime`: `TaskRuntime.listTasks()` returns replayed snapshots for every task, oldest first.
- `@bee-agent/server`: new `GET /tasks` listing endpoint; enables `@fastify/cors` (reflect-any-origin default, allowlist via `corsOrigin` option); the hijacked SSE response now writes its own `Access-Control-Allow-Origin` header because Fastify hooks never run for hijacked replies — without it browsers blocked the streamed body and feeds showed zero events.
- `@bee-agent/client`: `listTasks()` SDK method; the default fetch implementation is now bound to `globalThis` so the SDK works in browsers (a detached `fetch` throws "Illegal invocation" outside Node).
- `@bee-agent/cli`: new `bee task list` command.
- `@bee-agent/web`: Vite + React 19 task console (ADR 0011) built entirely on the Client SDK — task creation form, task list with state badges, a detail pane whose `useTaskStream` hook replays and then live-streams task events over SSE, approve/deny panels for pending approvals with optional reasons, cancellation, and a component test suite in jsdom.
