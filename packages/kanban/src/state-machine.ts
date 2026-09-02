import type {
  KanbanClaimLease,
  KanbanTask,
  KanbanTaskStatus,
} from './protocol.ts'

/**
 * The Kanban state machine (architecture §15.2). The active flow is
 * `inbox → triaged → ready → running → blocked/review → done`; every active
 * state can also be `failed`, `cancelled`, or `archived`, and terminal
 * states can be archived. Retry re-enters `ready`/`running` from `failed`,
 * a blocked or failed task resumes into `running`, and `running → ready`
 * releases a task back to the queue (lease expiry or a worker giving it
 * back). Only a task in `running` may hold a claim lease.
 */
export const KANBAN_TRANSITIONS: Readonly<
  Record<KanbanTaskStatus, readonly KanbanTaskStatus[]>
> = {
  inbox: ['triaged', 'cancelled', 'failed', 'archived'],
  triaged: ['ready', 'cancelled', 'failed', 'archived'],
  ready: ['running', 'cancelled', 'failed', 'archived'],
  running: [
    'ready',
    'blocked',
    'review',
    'done',
    'cancelled',
    'failed',
    'archived',
  ],
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
    super(
      `Illegal kanban transition '${from}' → '${to}'; legal targets from '${from}': ${allowedTransitions(from).join(', ')}`,
    )
    this.name = 'KanbanInvalidTransitionError'
  }
}

/**
 * Shortest legal hop sequence (excluding `from`, including `to`) between
 * two statuses, breadth-first over the transition table. Undefined when
 * no legal path exists — terminal states only leave toward `archived`.
 */
export function shortestTransitionPath(
  from: KanbanTaskStatus,
  to: KanbanTaskStatus,
): readonly KanbanTaskStatus[] | undefined {
  if (from === to) return []
  // Healthy hop order: among equal-length paths the walk prefers the
  // normal lifecycle (triaged/ready/running/review) over failed/cancelled
  // shortcuts — completing a task should not mark it failed on the way.
  // Terminal-ish states never serve as intermediate hops — completing a
  // task must not mark it failed on the way. They stay legal as the start
  // (that is the task's real state) or as the destination.
  const terminalish = (status: KanbanTaskStatus): boolean =>
    status === 'failed' || status === 'cancelled' || status === 'archived'
  const queue: KanbanTaskStatus[][] = [[from]]
  const seen = new Set<KanbanTaskStatus>([from])
  while (queue.length > 0) {
    const path = queue.shift()!
    const last = path[path.length - 1]!
    for (const next of allowedTransitions(last)) {
      if (seen.has(next)) continue
      if (next !== to && next !== from && terminalish(next)) continue
      const extended = [...path, next]
      if (next === to) return extended.slice(1)
      seen.add(next)
      queue.push(extended)
    }
  }
  return undefined
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
  /** Claim lease to attach when entering `running`; ignored otherwise. */
  readonly claim?: KanbanClaimLease | undefined
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
    // A lease is only meaningful while executing: entering `running` attaches
    // the command's claim (when given), leaving `running` releases it.
    claim: command.to === 'running' ? (command.claim ?? task.claim) : undefined,
  }
}
