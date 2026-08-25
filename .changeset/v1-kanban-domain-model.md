---
'@bee-agent/kanban': minor
---

Land the Kanban domain model (architecture §15.2, v1 refactor plan §5.2 P2-1).

- `KanbanTask` zod contract with the full field set: goal/acceptance criteria, priority, labels, dependencies (`blocks`/`related` with a `satisfiedWhen` status), source Thread/Turn, workspace, required capabilities, resource budget, `scheduledAt`/`deadline`, idempotency key, claim lease, and artifact/trajectory references, plus the `version`/timestamps the aggregate needs.
- The state machine table (`inbox → triaged → ready → running → blocked/review → done`, with `failed`/`cancelled`/`archived` reachable from every active state, retry from `failed`, and archive of terminal states) as pure `canTransition`/`allowedTransitions` helpers plus `applyTransition`, which bumps `version`, stamps `endedAt` on terminal entry, and clears the claim lease when leaving `running`.
- Expected-version concurrency: `applyTransition` throws `KanbanVersionConflictError` when the caller's `expectedVersion` no longer matches, and `KanbanInvalidTransitionError` for illegal transitions — distinct from the Chronicle stream-level sequence conflict.
- Chronicle wiring: `kanban.task.created` and `kanban.task.status_changed` event types registered on a `ChronicleSchemaRegistry`, event builders, a `kanban:<id>` stream convention, and `appendKanbanTaskEvents` for expected-sequence appends over any `ChronicleStore`. The store contract and dispatcher land in P2-2.
