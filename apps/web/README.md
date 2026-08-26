# Web

React 19 + Vite console built on `@bee-agent/client`. Components do not call
the Host with ad-hoc `fetch`; conversation, approval, SSE, and Kanban traffic
goes through the client SDK.

## Run

Start the v1 Personal Bee Host, then pass the same explicit session token to
the Web build:

```bash
BEE_AGENT_MODEL_API_KEY='<key>' \
BEE_AGENT_MODEL_NAME='<model>' \
BEE_AGENT_SESSION_TOKEN='local-development-token' \
pnpm --filter @bee-agent/bee start

VITE_BEE_AGENT_URL='http://127.0.0.1:3000' \
VITE_BEE_AGENT_SESSION_TOKEN='local-development-token' \
pnpm --filter @bee-agent/web dev
```

`VITE_BEE_AGENT_URL` defaults to `http://127.0.0.1:3000`. Both Vite variables
are baked in at build time.

## Current UI

- Thread creation and multi-Turn conversation.
- SSE Item replay followed by live updates.
- Approval/rejection and suspended-Turn resume.
- Durable Kanban board backed by the same Host store.
- Chat/board view switching.

The Host defaults to a loopback-only CORS policy and never reflects arbitrary
origins. Component tests use an injected fake client:

```bash
pnpm --filter @bee-agent/web test
```
