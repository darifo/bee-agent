# @bee-agent/bee

## 0.3.0

### Minor Changes

- ffc451d: Phase 5 WF5-D: autonomy-level activation makes approval take effect. A
  promoted L1/L2 proposal now activates immediately through the governed
  memory channel — the activation claim is recalled into subsequent turns, so
  promotion is a real behavior change — and records a durable
  `learning.proposal.activated` fact whose stream position becomes the
  claim's provenance. Rolling back a promoted proposal is one click too: the
  activation claim is retracted and `learning.proposal.activation-reverted`
  persists. Autonomy levels are enforced, not advisory: L0 proposals are
  evidence summaries and never activate; L3 requires the worktree ChangeSet
  pipeline and fails closed until it exists. Activation state rebuilds from
  the learning stream after restart. `POST /learning/proposals/:id/activate`
  is the idempotent retry path; the background learning cadence now also
  performs the L1-class memory consolidation after each loop run.
- ee86e09: Phase 5 WF5-E: drift monitoring with automatic rollback, plus the change
  budget. After a proposal is promoted and activated, real turns that arrive
  are the holdout the proposal never saw: `DriftMonitor` re-derives the
  pre-adoption evidence turns (immutable in Chronicle) as the baseline,
  derives the post-activation window, and compares the target metric — tool
  failure rate for skill/guardrail proposals, average checkpoints for
  planning ones. Regression beyond the budget margins rolls the proposal
  back automatically with the numbers in the durable reason, and every check
  appends a `learning.drift.checked` fact so even quiet windows stay
  auditable. Insufficient samples never judge. The Host runs the monitor on
  the learning cadence and auto-retracts activations for rolled-back
  proposals; `POST /learning/monitor` runs it on demand. The activation
  service enforces a change budget (default 5 simultaneously active
  activations) against uncontrolled drift — reaching it requires rolling one
  back first.
- 6ffcb88: Phase 5 WF5-C: ExperimentWorld, where proposals earn their evidence. Each
  experiment freezes a dataset of derived trajectories (digest-pinned over
  content, so later conversation activity cannot drift what is tested), runs
  an injectable evaluator in isolation — read-only facts, no
  memory/structure/behavior writes — and emits a durable report with a
  content-addressed changeset and a type-specific rollback package. The
  default `evidence-verify@1` evaluator recomputes the proposal's claimed
  pattern directly from the frozen data: inflated or invented claims are
  rejected by the evidence gate, which archives the proposal automatically;
  passing evidence waits in review for the user. Evaluator infrastructure
  failures persist a `learning.experiment.failed` fact and leave the proposal
  in testing for retry. Host routes: `POST
/learning/proposals/:id/experiment` and `GET
/learning/proposals/:id/experiments`.
- 260d4d7: Phase 5 foundation: the slow loop and governed ImprovementProposals. The
  new `@bee-agent/learning` package adds the ImprovementProposal domain
  (11 change types, the draft→testing→review→trial→promoted/rejected/
  rolled-back lifecycle with optimistic concurrency, L0–L3 autonomy levels
  where the loop itself may never exceed L2), a `learning` Chronicle stream
  with a rebuildable proposal projection, and the budgeted slow loop —
  Selection → Derivation → Consolidation → Pattern discovery over recent
  tool-using trajectories, with deliberately conservative deterministic
  baselines (high-frequency tool usage → skill candidates, repeated tool
  failures → guardrail observations, near-cap turn lengths → planning notes),
  open-target dedupe, per-run proposal caps, and a durable `learning.loop.run`
  audit fact per pass. The Host exposes `/learning/run`, `/learning/budget`,
  proposal listing/detail, and user-driven lifecycle transitions (409 on
  illegal jumps or stale versions), with an optional background cadence
  (default hourly). Integration test drives a real tool-using conversation
  into a skill proposal and walks it through review→trial→promoted→
  rolled-back.
- 93373c4: Phase 6 first slice: `bee doctor` and CLI governance over the new
  capability surfaces. A new `GET /diagnostics` endpoint summarizes every
  subsystem in one call — overall status, structure (active version, restart
  requirements, kernel doctor, config source), memory (health plus claim
  counts), world projection, scheduler, learning (proposals by status, loop
  and drift budgets), and thread count — degrading to `degraded` when memory
  is unavailable and never letting a provider outage fail the probe. The
  client SDK gains diagnostics plus the memory-governance
  (list/forget/consolidate) and learning-governance (run/list/show/experiment/
  transition/monitor) method families. The CLI adds `bee doctor`,
  `bee memory list|forget|consolidate`, and the full `bee learning`
  lifecycle (run/list/show/experiment/review/trial/promote/reject/rollback/
  monitor) — the governance arc from Phase 5 is now operable without curl.
- 76dc6ca: Phase 6 WF6-C: the v0 → v1 import tool. `POST /import/v0` (and `bee import
<path>`) reads a v0 SQLite event store read-only and converts each v0 task
  into one v1 Chronicle thread: task input becomes the user message, agent
  messages become message items, tool traffic becomes tool_call items with
  callId-correlated results and isError, approvals become approval items
  carrying the decision, and the terminal task state becomes the matching
  turn event. Every produced event carries `v0-import` provenance; the v0
  task id doubles as the thread id so re-running skips already-imported
  threads and reports them. Missing databases are a clean 404.

### Patch Changes

- Updated dependencies [ffc451d]
- Updated dependencies [ee86e09]
- Updated dependencies [6ffcb88]
- Updated dependencies [260d4d7]
  - @bee-agent/learning@0.3.0

## 0.2.0

### Minor Changes

- eacaf5e: Finish the remaining Phase 4 foundations. The unified personal data
  directory: durable Host artifacts now default to `BEE_AGENT_DATA_DIR` or the
  platform convention (macOS Application Support / XDG data home) instead of
  the working directory; explicit `BEE_AGENT_STORAGE_SQLITE_FILENAME` still
  wins. The memory-remote HTTP transport: `FetchMemoryTransport` speaks a
  documented `/memory/*` REST contract (query/ingest/context/representation/
  derive/consolidate/retract/export/health) with bearer auth and explicit
  `MemoryTransportError` status mapping; the Host switches to it — behind the
  existing circuit breaker with durable health events — when
  `BEE_AGENT_MEMORY_REMOTE_URL` is set. The transport is pinned by a
  reference HTTP server test running the full wire round-trip.
- a2540a2: Add the durable agent scheduler (Phase 4 WF4-F core): one-shot and recurring
  triggers that continue a bound thread across days and restarts. Trigger state
  lives on a serialized `scheduler` Chronicle stream (registered/triggered/
  removed events) and rebuilds on restart; ticks fire due triggers under a
  fire-once catch-up policy that collapses missed intervals into one run —
  reporting how many were skipped and resuming on the original cadence. Turns
  launched by the scheduler are marked with trigger `schedule`, and a crashing
  turn still advances the schedule (no hot loops). The Host enables the
  scheduler by default (5s auto-tick) and exposes `/scheduler/triggers` CRUD
  plus a manual `POST /scheduler/tick`.
- 34d0d4f: Add the Phase 4 personal memory foundation: the MemoryProvider contract with
  Claim/Observation/Representation schemas and a Chronicle-backed contract suite
  in knowledge; the embedded `memory-bee` provider (durable `memory` stream
  projection, lexical recall with CJK bigrams, deterministic preference/correction
  derivation, duplicate consolidation); AgentLoop retrieve-hook recall and a
  near-line derivation worker in runtime; and Host wiring with memory governance
  routes (`GET /memory/claims`, `POST /memory/claims/:id/retract`,
  `POST /memory/consolidate`, `GET /memory/export`), the Goal/Plan hook, and
  optional `BEE_AGENT_STRUCTURE_FILE` hot reload.
- b1a48bf: Added the keyless recorded-session replay safety net and parallel tool dispatch with ordered commit (P1 of the benchmark-driven hardening pass).

  - `@bee-agent/runtime`: tools declare `concurrency` (`parallel` | `exclusive`, absent = exclusive, fail-closed) on `ToolExecutor`/`ToolExecutionPort`; the AgentLoop groups consecutive same-class intents into segments — parallel-safe calls dispatch as a bounded concurrent batch (`maxParallelToolCalls`, default 8) while exclusive calls and segment boundaries stay strictly ordered. Results always enter history in model order regardless of completion order, so call/output pairing survives; batch appends serialize through a write queue because Chronicle appends position themselves by the stream tail (a race the replay harness caught). A resumed or crash-recovered step now finishes tool calls its last assistant message left unexecuted (rebuilt from history and re-dispatched under the existing idempotency keys) — previously sibling calls after a suspended approval were silently dropped, leaving the model a tool-call without its result.
  - `@bee-agent/server`: the composite tool executor reports concurrency per call; `kanban_list`/`kanban_show` are parallel-safe, everything else stays exclusive until its adapter opts in.
  - Replay harness (`packages/runtime/tests/replay`): fixtures script recorded model responses and tool outcomes, the harness runs the real AgentLoop + ModelRequestService + Chronicle pipeline keylessly, and diffs turn results, the exact model-visible requests, and every Chronicle stream against the recorded expectation (uuid/timestamp normalization with stable placeholder mapping). Seven fixtures pin chat, tool round-trip, tool-error isolation, approval suspend/resume, max-tokens escalation, retry recovery, and parallel batches. Regenerate after intentional changes with `REPLAY_RECORD=1 pnpm --filter @bee-agent/runtime test`. First recordings caught and fixed a real bug: tool messages serialized `isError: undefined` into model-request sources, producing JSON that request replay could not parse.

- b1a48bf: System prompt assembly with cache discipline (benchmark-driven hardening pass, step 6): the model-visible request finally starts with a system message, and the context package's budget allocation is now on the live path.

  - `@bee-agent/runtime`: new `system-prompt` module — `SystemPromptAssembler` joins prioritized sections (identity before instructions before environment) under a token budget via the context package's `allocateContextBudget`, protects sections that must survive, and produces a digest-verified manifest plus the omitted-section ids for audit. `AgentLoopOptions.systemPrompt` takes a plain string, a lazy provider, or an assembler; the loop resolves it once (memoized) and prepends the identical system message object to every generation, so the prefix stays byte-stable for provider caching. Dynamic context keeps flowing through the retrieve/plan hooks as late messages — the documented rule is that anything per-turn belongs there, never in the system message.
  - `@bee-agent/server`: the Host ships a default Bee system prompt — identity, the declared-tool execution model, deny-by-default sandbox/approval awareness (including that a tool error is a reactable result and that resumed turns continue from recorded state), and durable-task guidance — factual to behavior that exists, overridable wholesale via `BEE_AGENT_SYSTEM_PROMPT`. The system message lands in request manifests as `instruction` sections, so request replay audits it like everything else.
  - Covered by assembler unit tests (priority join, budget omission, memoization, determinism), AgentLoop integration tests (single resolution across generations, identical message object, assembler input), a recorded replay fixture pinning the system-first message order, and updated host composition/memory-outage assertions that now expect the leading system prompt.

- 1c6c976: Add the Personal Bee Host minimal form (`apps/bee`, architecture §9.1): one Fastify process serving the Thread–Turn–Item API over a Chronicle store. `POST /threads` creates a thread, `POST /threads/:id/turns` runs the AgentLoop, `POST /threads/:id/turns/:turnId/approvals/:approvalId` resumes a suspended turn, and `GET /threads/:id/items` streams thread events over SSE with `Last-Event-ID` recovery. A `BroadcastingChronicleStore` decorator emits appends so the SSE endpoint follows live events without polling.
- fa14714: Apply the security defaults from architecture §16.4 to the host. CORS no longer reflects any origin — it defaults to a loopback-only policy (`loopbackOrigins`) and both the Fastify routes and the hijacked SSE stream honor it. Binding a non-loopback address now fails closed unless a `BEE_AGENT_SESSION_TOKEN` is set (`unsafeListenReason`); the host generates a fresh one-time session token per startup and enforces it via `Authorization: Bearer` on every route except `/health`.
- 84e646b: Land the Kanban API and agent tools (v1 refactor plan §5.2 P2-3).

  - `@bee-agent/kanban` adds `update` (a field-only mutation) and `comment` operations with the `kanban.task.updated` / `kanban.task.commented` events and a `comments` field folded into the projection, plus the eight lazy-loadable `kanban_*` tool definitions and `createKanbanToolExecutor` — the one store the REST API, agent tools, CLI, Web, and Scheduler all share.
  - `@bee-agent/bee` wires a `KanbanStore` into the host: `/kanban/tasks` REST endpoints (create/list/show/update/block/comment/complete/cancel) and a composite tool slot that routes `kanban_*` calls to the store while exposing the tool specs to the model; `main.ts` recovers the board from SQLite on startup (`rebuild`).
  - `@bee-agent/client` adds `createTask`/`listTasks`/`getTask`/`updateTask`/`blockTask`/`commentTask`/`completeTask`/`cancelTask`.
  - `@bee-agent/cli` adds a minimal `kanban create/list/show` command group.

- bedbda4: Link Kanban tasks and Threads bidirectionally (v1 refactor plan §5.2 P2-4).

  - `KanbanSource` gains `itemId` (the originating tool_call item), so a task points at its Thread, Turn, and originating Item in one hop; artifact and trajectory references stay on the task for the Episode/Artifact direction.
  - `KanbanStore.list` gains `sourceThreadId` / `sourceItemId` filters, so a Thread or Item resolves back to its tasks in one hop — no multi-hop joins.
  - The kanban tool executor accepts a `context` (`threadId`/`turnId`/`itemId`) and `kanban_create` records it as the task's `source`; `AgentLoopToolSlotCall` now carries the tool_call `itemId`, and the host wires that context through to the executor.

- 149fddf: Add the WorldModel foundation (Phase 4 WF4-D): world entities, provenance-
  carrying relations, and versioned snapshots in knowledge, with a serialized
  `world` Chronicle stream whose version bumps carry a digest of the full
  projected state — rebuilds verify every digest and fail loud on drift. A
  sourced `WorldProjector` seam derives facts only from Chronicle events (the
  bundled `ThreadToolProjector` records agent-to-tool usage with exact item
  provenance); unevidenced assertions cannot enter the model. The Host now
  maintains the projection (catch-up replay at start plus live append
  projection) and serves a read-only `GET /world` view with kind/type/entity
  filters.

### Patch Changes

- Updated dependencies [b1a48bf]
- Updated dependencies [eacaf5e]
- Updated dependencies [a2540a2]
- Updated dependencies [9be74e1]
- Updated dependencies [34d0d4f]
- Updated dependencies [6c62bd0]
- Updated dependencies [b1a48bf]
- Updated dependencies [b1a48bf]
- Updated dependencies [b1a48bf]
- Updated dependencies [b1a48bf]
- Updated dependencies [85be532]
- Updated dependencies [e359897]
- Updated dependencies [e359897]
- Updated dependencies [cdcba95]
- Updated dependencies [7cc0dd1]
- Updated dependencies [84e646b]
- Updated dependencies [8e04cd7]
- Updated dependencies [40988a8]
- Updated dependencies [bedbda4]
- Updated dependencies [066bd78]
- Updated dependencies [e606923]
- Updated dependencies [b784d27]
- Updated dependencies [4c7f805]
- Updated dependencies [7460bb1]
- Updated dependencies [066bd78]
- Updated dependencies [4ebc68b]
- Updated dependencies [85be532]
- Updated dependencies [de9f3f4]
- Updated dependencies [1c6c976]
- Updated dependencies [b67f04a]
- Updated dependencies [149fddf]
  - @bee-agent/runtime@1.0.0
  - @bee-agent/memory-remote@0.2.0
  - @bee-agent/kernel@1.0.0
  - @bee-agent/knowledge@0.2.0
  - @bee-agent/memory-bee@0.2.0
  - @bee-agent/model-providers@1.0.0
  - @bee-agent/thread@0.2.0
  - @bee-agent/kanban@0.2.0
  - @bee-agent/storage-sqlite@0.2.0
  - @bee-agent/tool-command@0.1.1
  - @bee-agent/tool-mcp@0.1.1
  - @bee-agent/tool-python@0.1.1
