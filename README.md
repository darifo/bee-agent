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

## Project status

**v0.11 is in maintenance mode.** Active development happens on the
`feature/v1.0.0` branch, which rebuilds Bee Agent as a local-first personal
super agent: the Thread–Turn–Item interaction protocol, durable Kanban tasks,
Chronicle event sourcing, budgeted context, sandboxed execution, and governed
background learning. `main` only receives critical v0 fixes, and the v0 line is
frozen at the `v0.11.0-legacy` tag. The v1 architecture plan and refactor
development plan live in [`docs/architecture`](./docs/architecture) (Chinese).

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
- **Lifecycle safety** — Cordis-derived Context/Registry/Fiber ownership manages
  services and effects; reference-counted structure generations keep live Turns stable.
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
  server["Bee Host<br/>HTTP · SSE · Plugin Graph"]
  kernel["Bee Kernel<br/>Context · Registry · Fiber · Generations"]
  runtime["Agent Runtime<br/>Thread · Turn · Item · AgentLoop"]
  storage["Chronicle + Storage<br/>Facts · Projections"]
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

| Area                     | Status    | Details                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo toolchain       | Available | pnpm workspaces, strict TypeScript, ESLint, Prettier, Vitest, Changesets, and CI                                                                                                                                                                                                                                                                        |
| Shared contracts         | Available | Task, event, tool, approval, memory, embedding, vector-search, API, and SSE schemas                                                                                                                                                                                                                                                                     |
| Cordis-derived kernel    | Available | Proxy Context, inject-driven Registry/Fiber activation, Fiber-owned effects, scoped service isolation, immutable StructureGeneration switching, Turn leases, monotonic ContextPolicy, and restart-required governance                                                                                                                                   |
| Structure reconciliation | Available | EffectiveStructure-driven PluginFactoryRegistry, serialized candidate activation, Chronicle lifecycle facts, failed-candidate rollback, active-structure restart rebuild, and local inspect/reconcile endpoints                                                                                                                                         |
| Core runtime             | Available | Chronicle-backed Thread–Turn–Item AgentLoop, tool execution and approval suspension/recovery seams, plus Goal/Plan support; AgentLoop is exposed as a Kernel-managed plugin service                                                                                                                                                                     |
| SQLite storage           | Available | Migration, transactions, rollback, append-only events, atomic task sequences, and replay, verified by the shared storage contract suite                                                                                                                                                                                                                 |
| Server                   | Available | Fastify composition root: REST commands with task listing, SSE event streaming with `Last-Event-ID` resume, approval decisions, CORS (including hijacked streams), error envelopes with mapped statuses                                                                                                                                                 |
| Client SDK and CLI       | Available | `@bee-agent/client` (REST + SSE streaming with abort support, browser-safe fetch) and the `bee` CLI for task list/create/run/watch/cancel and approval decide                                                                                                                                                                                           |
| Web UI                   | Available | React 19 + Vite console on the Client SDK: task creation, live SSE event feed, approval approve/deny with reasons, cancellation, jsdom component tests                                                                                                                                                                                                  |
| PostgreSQL storage       | Available | Pooled adapter on the shared contract suite: transactions that join when re-entered, atomic sequence allocation, JSONB events, oldest-first task listing, single-dialect server mode                                                                                                                                                                    |
| pgvector store           | Available | Vector Store adapter on pgvector: embedding-space registry that validates dimensions and freezes model/metric, cosine/euclidean/inner-product search with workspace scoping and metadata filters, contract-tested; the memory runtime that feeds it is a later stage                                                                                    |
| Memory runtime           | Available | Workspace semantic memory (ADR 0012): word-boundary chunking, pluggable `Embedder` (deterministic mock until real providers), recall ranked by vector proximity, `remember`/`recall`/`forget` over REST/SDK/CLI                                                                                                                                         |
| Model providers          | Available | OpenAI-compatible HTTP providers (ADR 0013): `OpenAIChatAgent` with a bounded tool-calling loop and `OpenAIEmbedder` with declared dimensions; DeepSeek/OpenAI/compatible gateways via `BEE_AGENT_MODEL_*` / `BEE_AGENT_EMBEDDING_*` env, keys never persisted                                                                                          |
| MCP tools                | Available | Zero-dependency MCP stdio client (ADR 0014): each configured server runs as its own child process, tools register as `mcp.<server>.<tool>` and flow through the policy pipeline; server death surfaces as tool errors with the stderr tail; children stop with the kernel                                                                               |
| Python tool              | Available | Opt-in `tools.python` (ADR 0015, env `BEE_AGENT_ENABLE_PYTHON`): one-shot interpreter per call with `args` injection, stdout-as-output contract (JSON parsed), timeouts, output caps, and stderr-mapped tool errors — crash isolation, not a security sandbox                                                                                           |
| External agents          | Available | Adapters behind the `Agent` contract (ADR 0016): `RemoteAgent` federates a run to another Bee Agent server over the Client SDK with message mirroring and cancellation propagation; `CommandAgent` wraps any executable (`{input}` argv or stdin, stdout is the reply, timeouts); registered via `buildServer({ agents })` / `BEE_AGENT_COMMAND_AGENTS` |

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

### Running with real models (DeepSeek and other OpenAI-compatible providers)

The mock agent is the default; point the server at any OpenAI-compatible
provider with environment variables (ADR 0013 — keys never touch the
repository):

```bash
BEE_AGENT_MODEL_PROVIDER=openai-compatible \
BEE_AGENT_MODEL_BASE_URL=https://api.deepseek.com \
BEE_AGENT_MODEL_API_KEY=$DEEPSEEK_API_KEY \
BEE_AGENT_MODEL_NAME=deepseek-chat \
pnpm --filter @bee-agent/server start

bee task create -i "compute 12*7+15 with the calculator" -a agent.deepseek
bee task run <taskId>    # the model calls the calculator tool, then answers
```

The same pattern configures a real embedder for memory
(`BEE_AGENT_EMBEDDING_PROVIDER/BASE_URL/API_KEY/MODEL/DIMENSIONS`).

### Mounting MCP tool servers

`BEE_AGENT_MCP` takes a JSON array of stdio MCP server configs (ADR 0014);
each server becomes `mcp.<name>.*` tools available to every agent —
including real models:

```bash
BEE_AGENT_MCP='[{"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}]' \
pnpm --filter @bee-agent/server start

bee task create -i "list the files under /tmp and read notes.txt" -a agent.deepseek
bee task run <taskId>    # the model drives the MCP filesystem tools
```

### Enabling the Python tool

`tools.python` runs code in a fresh one-shot interpreter per call and is
**opt-in** (ADR 0015 — crash isolation, not a security sandbox; keep it
disabled for untrusted users or run the server in a container):

```bash
BEE_AGENT_ENABLE_PYTHON=1 pnpm --filter @bee-agent/server start

bee task create -i "compute 2**100 exactly with the python tool" -a agent.deepseek
bee task run <taskId>    # the model writes python, the tool prints the result
```

### Registering external agents

Two adapters turn outside systems into `agentId`s (ADR 0016):
`RemoteAgent` delegates runs to another Bee Agent server, and
`CommandAgent` wraps any executable — the `{input}` placeholder carries the
task input and stdout becomes the reply:

```bash
BEE_AGENT_COMMAND_AGENTS='[{"id":"agent.upper","command":"tr","args":["a-z","A-Z"],"inputVia":"stdin"}]' \
pnpm --filter @bee-agent/server start

bee task create -i "shout this" -a agent.upper
bee task run <taskId>    # prints SHOUT THIS
```

`buildServer({ agents })` registers either adapter programmatically;
`RemoteAgent` takes `{ id, baseUrl, remoteAgentId }`.

### Running on PostgreSQL

One storage dialect per instance (ADR 0004); pick it with environment
variables — SQLite is the default:

```bash
docker run -d --name bee-agent-pg \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=bee_agent \
  -p 127.0.0.1:5432:5432 pgvector/pgvector:pg17

BEE_AGENT_STORAGE_DIALECT=postgres \
BEE_AGENT_STORAGE_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/bee_agent \
BEE_AGENT_VECTOR_STORE=pgvector \
pnpm --filter @bee-agent/server start
```

`BEE_AGENT_VECTOR_STORE=pgvector` mounts the Vector Store plugin (ADR 0005)
under the kernel's `vector-store` service key; it requires the PostgreSQL
dialect and keeps vectors in dedicated tables (ADR 0006). It also enables
workspace memory over the same store:

```bash
bee memory remember -w docs -t "the cat sat on the mat"
bee memory recall -w docs -q "cat mat"
```

The PostgreSQL integration tests need the same URL and skip without it:

```bash
BEE_AGENT_STORAGE_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/bee_agent pnpm test
```

## Repository structure

```text
bee-agent/
├── apps/
│   ├── bee/                 # Fastify Host; composes core services as a Kernel plugin graph
│   └── web/                 # React client
├── packages/
│   ├── kernel/              # Cordis-derived runtime + Bee StructureGeneration governance
│   ├── knowledge/           # Chronicle contracts and structure events
│   ├── thread/              # Thread–Turn–Item protocol
│   ├── runtime/             # AgentLoop and runtime plugins
│   ├── context/             # ContextManifest, budgets, lazy Skills/Tools
│   ├── kanban/              # Durable task plane
│   ├── execution/           # Execution boundary contracts
│   └── model-providers/     # OpenAI-compatible LLM providers
├── adapters/
│   └── storage/sqlite/      # SQLite Chronicle and Kanban stores
├── tests/                   # Shared integration and E2E suites
└── docs/                    # ADRs and the v1 architecture/refactor plans
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
- [x] Implement pgvector and embedding-space validation
- [x] Add the memory runtime on the Vector Store
- [x] Add real model providers over OpenAI-compatible HTTP
- [x] Add MCP tool servers over the stdio bridge
- [x] Add the opt-in Python worker tool
- [x] Add external agents behind the Agent contract
- [x] v1 Phase 0: freeze v0, core ADRs, new package skeletons, and CI gates
- [x] v1 Phase 1: Cordis-derived base and the Thread–Turn–Item protocol
- [x] v1 Phase 2: Kanban, context budgets, and lazy Skills/Tools
- [x] Kernel optimization: Registry/Fiber single source, StructureGeneration, Turn pinning, Host plugin graph
- [ ] v1 Phase 3: unified ExecutionWorld and sandbox boundaries
- [ ] v1 Phase 4: personal memory, world model, and the long-running host
- [ ] v1 Phase 5: background learning and governed improvement
- [ ] v1 Phase 6: experience convergence and the 1.0.0 release

Architecture decisions and their constraints are recorded in
[`docs/adr`](./docs/adr); the v1 plans are in
[`docs/architecture`](./docs/architecture).

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
