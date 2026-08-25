import type { KanbanTask, KanbanTaskStatus } from './protocol.ts'

/**
 * The Kanban state machine (architecture §15.2). The active flow is
 * `inbox → triaged → ready → running → blocked/review → done`; every active
 * state can also be `failed`, `cancelled`, or `archived`, and terminal
 * states can be archived. Retry re-enters `ready`/`running` from `failed`,
 * and a blocked or failed task resumes into `running`. Only a task in
 * `running` may hold a claim lease.
 */
export const KANBAN_TRANSITIONS: Readonly<
  Record<KanbanTaskStatus, readonly KanbanTaskStatus[]>
> = {
  inbox: ['triaged', 'cancelled', 'failed', 'archived'],
  triaged: ['ready', 'cancelled', 'failed', 'archived'],
  ready: ['running', 'cancelled', 'failed', 'archived'],
  running: ['blocked', 'review', 'done', 'cancelled', 'failed', 'archived'],
  blocked: ['running', 'ready', 'cancelled', 'failed', 'archived'],
  review: ['done', 'running', 'cancelled', 'failed', 'archived'],
  done: ['archived'],
  failed: ['ready', 'running', 'cancelled', 'archived'],
  cancelled: ['archived'],
  archived: [],
}

export const KANBAN_TERMINAL_STATUSES = [
  'done',
  'failed',
  'cancelled',
  'archived',
] as const satisfies readonly KanbanTaskStatus[]

export function isTerminal(status: KanbanTaskStatus): boolean {
  return (KANBAN_TERMINAL_STATUSES as readonly string[]).includes(status)
}

export function isActive(status: KanbanTaskStatus): boolean {
  return !isTerminal(status)
}

/** The statuses a task may move to from `from`, in declaration order. */
export function allowedTransitions(
  from: KanbanTaskStatus,
): readonly KanbanTaskStatus[] {
  return KANBAN_TRANSITIONS[from]
}

export function canTransition(
  from: KanbanTaskStatus,
  to: KanbanTaskStatus,
): boolean {
  return (KANBAN_TRANSITIONS[from] as readonly string[]).includes(to)
}

export class KanbanInvalidTransitionError extends Error {
  constructor(
    readonly from: KanbanTaskStatus,
    readonly to: KanbanTaskStatus,
  ) {
    super(`Illegal kanban transition '${from}' → '${to}'`)
    this.name = 'KanbanInvalidTransitionError'
  }
}

/**
 * Optimistic-concurrency conflict: the caller based the transition on a task
 * version that has since moved on. Distinct from the Chronicle stream-level
 * `ChronicleSequenceConflictError` — this guards the aggregate `version`.
 */
export class KanbanVersionConflictError extends Error {
  constructor(
    readonly taskId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `Kanban task '${taskId}' expected version ${expectedVersion} but is at ` +
        `version ${actualVersion}`,
    )
    this.name = 'KanbanVersionConflictError'
  }
}

export interface KanbanTransitionCommand {
  readonly to: KanbanTaskStatus
  /** The version the caller read; must equal the task's current version. */
  readonly expectedVersion: number
  readonly reason?: string | undefined
  /** Transition time; defaults to now, injectable for deterministic tests. */
  readonly at?: string | undefined
}

/**
 * Applies one state transition to a task: rejects an unknown transition and
 * a version mismatch, otherwise returns the task at the next version with
 * its status, `updatedAt`, `endedAt` (set when entering a terminal state),
 * and claim lease (cleared when leaving `running`) updated. The returned
 * task is a value, not a mutation — the caller persists it and its
 * `kanban.task.status_changed` event (see `events.ts`).
 */
export function applyTransition(
  task: KanbanTask,
  command: KanbanTransitionCommand,
): KanbanTask {
  if (command.expectedVersion !== task.version) {
    throw new KanbanVersionConflictError(
      task.id,
      command.expectedVersion,
      task.version,
    )
  }
  if (!canTransition(task.status, command.to)) {
    throw new KanbanInvalidTransitionError(task.status, command.to)
  }
  const at = command.at ?? new Date().toISOString()
  const terminal = isTerminal(command.to)
  return {
    ...task,
    status: command.to,
    version: task.version + 1,
    updatedAt: at,
    endedAt: terminal ? at : task.endedAt,
    // A lease is only meaningful while executing; leaving `running`
    // releases it. Attaching/renewing a lease is the dispatcher's job (P2-2).
    claim: command.to === 'running' ? task.claim : undefined,
  }
}
