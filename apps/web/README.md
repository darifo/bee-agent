# Web

React 19 + Vite single-page console for Bee Agent, built entirely on
`@bee-agent/client` (ADR 0011). All server access goes through the Client
SDK; components never call `fetch` directly.

## Run

Start the API server first, then point the dev server at it:

```bash
pnpm --filter @bee-agent/server start                        # :3000
VITE_BEE_AGENT_URL=http://127.0.0.1:3000 \
  pnpm --filter @bee-agent/web dev                            # :5173
```

`VITE_BEE_AGENT_URL` is baked in at build time (default
`http://127.0.0.1:3000`); `pnpm --filter @bee-agent/web build` produces the
production bundle in `dist/`.

The server enables CORS (reflect-any-origin by default, allowlist via the
`corsOrigin` build option), including on the hijacked SSE stream.

## Features

- Create tasks and start them with the mock agent (or any registered agent
  id).
- Task list with state badges, inputs, and event counts, backed by
  `GET /tasks`.
- Detail pane: live SSE event feed — recorded events replay first, then live
  events arrive and the stream closes at terminal states.
- Approve/deny panels with optional reasons while a task is suspended in
  `waiting_approval`; cancellation for pending, running, or suspended tasks.

Component tests run in jsdom with an injected fake client:

```bash
pnpm --filter @bee-agent/web test
```
