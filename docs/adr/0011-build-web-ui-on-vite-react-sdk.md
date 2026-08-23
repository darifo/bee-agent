# ADR 0011: Build the Web UI on Vite, React, and the Client SDK

## Background

The roadmap needs a browser client for the task console. ADR 0003 already fixed the transport (REST + SSE) and requires all clients to go through the Client SDK.

## Decision

Ship `apps/web` as a Vite + React 19 single-page app that talks to the server exclusively through `@bee-agent/client`:

- Views: a task creation form, a task list (backed by the new `GET /tasks` / `listTasks()` chain), a detail pane with a live SSE event feed, and approve/deny controls for pending approvals.
- The `useTaskStream` hook consumes `streamEvents` (replay from sequence zero, then live) and aborts on task change or unmount; terminal states end the stream server-side.
- The server enables `@fastify/cors` (reflect-any-origin by default in this engineering preview, configurable to an allowlist) because the dev servers run on different ports.
- The hijacked SSE response writes its own `Access-Control-Allow-Origin` header: Fastify hooks (including CORS) never run for hijacked replies.

## Reasons

Reusing the SDK keeps one transport implementation for CLI and Web, and the SSE generator maps naturally onto React state; the event store remains the single source of truth for both replay and live views.

## Alternatives

A server-rendered app, a full framework with client-side routing, or talking to the HTTP API directly from components.

## Positive impact

One SDK to maintain and test; the browser console exercises the same streaming contract as the CLI; component tests run in jsdom against an injected fake client.

## Negative impact

List views re-replay every task snapshot on refresh (acceptable at engineering-preview scale; pagination can follow); browser smoke testing caught environment-specific fetch binding and hijacked-reply CORS issues that Node tests cannot see.

## Follow-up constraints

Components must not call `fetch` directly — all server access stays in the SDK; any new route consumed by the Web UI needs CORS-safe responses, including hijacked streams.
