<p align="center">
  <img src="docs/assets/bee-agent-logo.png" alt="Bee Agent Logo" width="200" />
</p>

<h1 align="center">Bee Agent</h1>

<p align="center">
  <strong>Cordis-based, Plugin-composed, Modular, Traceable, Extensible, Self-evolving Agent</strong>
</p>

<p align="center">
  <a href="https://github.com/darifo/bee-agent/actions/workflows/ci.yml">
    <img src="https://github.com/darifo/bee-agent/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" />
  </a>
  <a href="https://nodejs.org/">
    <img src="https://img.shields.io/badge/node-%3E%3D22-green.svg" alt="Node" />
  </a>
  <a href="https://www.typescriptlang.org/">
    <img src="https://img.shields.io/badge/TypeScript-strict-3178C6.svg" alt="TypeScript" />
  </a>
  <img src="https://img.shields.io/badge/readiness-engineering%20preview-orange.svg" alt="Engineering preview" />
</p>

<p align="center">
  English | <a href="./README-ZH.md">简体中文</a>
</p>

---

## Overview

Bee Agent is an open-source, Cordis-based agent composed from plugins. It
assembles agent runtimes, tools, policies, storage adapters, and external
workers without coupling them to one monolithic core. It is designed around
explicit lifecycle management, append-only execution history, stable plugin
contracts, and interchangeable infrastructure.

The project aims to support coding, research, office automation, data analysis,
and content workflows through a shared runtime that can be inspected, tested,
paused, resumed, and extended.

## Why Bee Agent?

- **Modular by design** — runtime capabilities live behind package and plugin
  boundaries instead of accumulating in a single core.
- **Traceable execution** — task events are append-only, ordered, and replayable.
- **Lifecycle safety** — Cordis contexts and scopes manage services, effects, and
  task-scoped resource cleanup.
- **Storage portability** — domain contracts keep SQLite and PostgreSQL details
  out of runtime code.
- **Schema-first contracts** — Zod schemas provide runtime validation and strict
  TypeScript types across packages.
- **Extensible capabilities** — the architecture reserves clean boundaries for
  tools, policies, models, MCP integrations, Python workers, and external agents.
- **Self-evolving composition** — the agent grows by mounting, replacing, and
  upgrading plugins behind stable contracts instead of rewriting a core.

## Architecture

```mermaid
flowchart TB
  clients["Clients<br/>Web · CLI · Desktop"]
  server["Agent Server<br/>HTTP · SSE · Composition Root"]
  kernel["Cordis Kernel<br/>Context · Scope · Services · Lifecycle"]
  runtime["Core Runtimes<br/>Task · Agent · Policy · Memory"]
  storage["Storage Contracts<br/>Event Store · Vector Store"]
  plugins["Capability Plugins<br/>Tools · Models · Policies"]
  adapters["External Adapters<br/>MCP · Python · Agent Harnesses"]

  clients --> server
  server --> kernel
  kernel --> runtime
  runtime --> storage
  runtime --> plugins
  plugins --> adapters
```

The Web client shown above is a planned layer. The server, Client SDK, and CLI
are implemented today, alongside the kernel, core runtimes, contracts, storage
abstractions, and SQLite Event Store.

## Current capabilities

| Area               | Status    | Details                                                                                                                                                                                                         |
| ------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo toolchain | Available | pnpm workspaces, strict TypeScript, ESLint, Prettier, Vitest, Changesets, and CI                                                                                                                                |
| Shared contracts   | Available | Task, event, tool, approval, memory, embedding, vector-search, API, and SSE schemas                                                                                                                             |
| Cordis kernel      | Available | Lifecycle state machine, service keys, catalog, and waiters, domain events with waterfall middleware, task scopes with service isolation, Cordis and Bee Agent plugin mounting                                  |
| Core runtimes      | Available | Task state machine with replayable lifecycle events and snapshots, agent contract with mock agent, tool registry and `tools/execute` pipeline, policy engine with approval suspension, expiry, and cancellation |
| SQLite storage     | Available | Migration, transactions, rollback, append-only events, atomic task sequences, and replay, verified by the shared storage contract suite                                                                         |
| Server             | Available | Fastify composition root: REST commands with task listing, SSE event streaming with `Last-Event-ID` resume, approval decisions, CORS (including hijacked streams), error envelopes with mapped statuses         |
| Client SDK and CLI | Available | `@bee-agent/client` (REST + SSE streaming with abort support, browser-safe fetch) and the `bee` CLI for task list/create/run/watch/cancel and approval decide                                                   |
| Web UI             | Available | React 19 + Vite console on the Client SDK: task creation, live SSE event feed, approval approve/deny with reasons, cancellation, jsdom component tests                                                          |
| PostgreSQL storage | Available | Pooled adapter on the shared contract suite: transactions that join when re-entered, atomic sequence allocation, JSONB events, oldest-first task listing, single-dialect server mode                            |
| pgvector memory    | Planned   | Vector Store contract and plugin boundary are defined; search is deferred                                                                                                                                       |

## Requirements

- [Node.js](https://nodejs.org/) 22 or newer
- [pnpm](https://pnpm.io/) 10

## Quick start

Clone the repository and install its dependencies:

```bash
git clone git@github.com:darifo/bee-agent.git
cd bee-agent
pnpm install
```

Run the full local verification suite:

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

Start the server and drive it from the CLI or the Web console:

```bash
pnpm --filter @bee-agent/server start          # http://127.0.0.1:3000

export BEE_AGENT_URL=http://127.0.0.1:3000
bee() { pnpm --filter @bee-agent/cli bee -- "$@"; }
bee task create -i "hello"                     # prints the task id
bee task run <taskId>                          # streams events until the task finishes

pnpm --filter @bee-agent/web dev               # http://localhost:5173
```

### Running on PostgreSQL

One storage dialect per instance (ADR 0004); pick it with environment
variables — SQLite is the default:

```bash
docker run -d --name bee-agent-pg \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=bee_agent \
  -p 127.0.0.1:5432:5432 pgvector/pgvector:pg17

BEE_AGENT_STORAGE_DIALECT=postgres \
BEE_AGENT_STORAGE_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/bee_agent \
pnpm --filter @bee-agent/server start
```

The PostgreSQL integration tests need the same URL and skip without it:

```bash
BEE_AGENT_STORAGE_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/bee_agent pnpm test
```

## Repository structure

```text
bee-agent/
├── apps/
│   ├── server/              # Fastify HTTP + SSE composition root
│   ├── cli/                 # Commander-based `bee` client
│   └── web/                 # React 19 + Vite task console
├── packages/
│   ├── contracts/           # Zod schemas and shared domain/transport types
│   ├── plugin-sdk/          # Public plugin manifest and lifecycle contract
│   ├── kernel/              # Cordis foundation: lifecycle, services, scopes, plugins
│   ├── runtime/             # Core runtimes: task loop, state machine, agents, policies, tools
│   ├── client/              # Client SDK: REST commands + SSE event streaming
│   ├── storage/             # Storage and transaction boundaries
│   ├── event-store/         # Append-only Event Store contract
│   └── vector-store/        # Vector Store and embedding-space boundary
├── plugins/
│   ├── storage/sqlite/      # Working SQLite storage and Event Store
│   ├── storage/postgres/    # Working PostgreSQL storage and Event Store
│   ├── tools/calculator/    # Working calculator tool plugin
│   └── vector/pgvector/     # Reserved pgvector adapter boundary
├── adapters/                # Future external protocol and agent adapters
├── python/                  # Future Python worker projects
├── migrations/              # Dialect-specific database migrations
├── configs/                 # Environment configuration examples
├── tests/                   # Shared contract, integration, and E2E suites
└── docs/adr/                # Architecture Decision Records
```

## Development

| Command             | Purpose                                           |
| ------------------- | ------------------------------------------------- |
| `pnpm build`        | Build all implemented workspace packages          |
| `pnpm typecheck`    | Run strict TypeScript checks across the workspace |
| `pnpm lint`         | Run ESLint                                        |
| `pnpm test`         | Run all package tests                             |
| `pnpm format`       | Format supported files with Prettier              |
| `pnpm format:check` | Verify formatting without modifying files         |
| `pnpm changeset`    | Describe a package-level release change           |

### Workspace rules

- Import other workspaces only through their package exports; never import their
  internal `src/` paths.
- Keep core packages independent of concrete plugins.
- Keep database-specific behavior inside storage adapters.
- Give every package and plugin its own manifest and public boundary.
- Add tests for public contracts and lifecycle-sensitive behavior.

## Database model

SQLite is the only working database adapter at this stage. Its Event Store uses
a transaction and a per-task sequence row to allocate monotonically increasing
event sequences. It does not use an unsafe `MAX(sequence) + 1` allocation.

SQLite and PostgreSQL are separate runtime modes: Bee Agent will never dual-write
to both databases. Vector data is also kept outside task event tables through a
dedicated Vector Store contract.

## Roadmap

- [x] Initialize the pnpm TypeScript monorepo and quality toolchain
- [x] Define shared contracts and plugin SDK boundaries
- [x] Implement the Cordis kernel and task-scope cleanup
- [x] Implement and test the SQLite Event Store
- [x] Add the task state machine, policy engine, calculator tool, and mock agent
- [x] Add the HTTP/SSE server, Client SDK, and CLI
- [x] Add the React Web UI
- [x] Implement PostgreSQL using the shared storage contract suite
- [ ] Implement pgvector and embedding-space validation
- [ ] Add memory, real model providers, MCP, Python workers, and external agents

Architecture decisions and their constraints are recorded in
[`docs/adr`](./docs/adr).

## Contributing

Contributions are welcome while the architecture is taking shape.

1. Open an issue to discuss substantial behavior or public API changes.
2. Fork the repository and create a focused branch.
3. Add or update tests with your change.
4. Run `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test`.
5. Submit a pull request describing the motivation, behavior, and trade-offs.

Please keep changes within package boundaries and record significant
architectural decisions as ADRs.

## License

Bee Agent is available under the [MIT License](./LICENSE).
