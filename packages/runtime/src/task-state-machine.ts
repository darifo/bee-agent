import type { TaskState } from '@bee-agent/contracts'

/**
 * Allowed task state transitions. A task starts as `pending`, moves to
 * `running` when the runtime starts it, may suspend into `waiting_approval`
 * while a policy demands an approval decision, and ends in one of the
 * terminal states `completed`, `failed`, or `cancelled`.
 */
export const TASK_STATE_TRANSITIONS: Readonly<
  Record<TaskState, readonly TaskState[]>
> = {
  pending: ['running', 'cancelled'],
  running: ['waiting_approval', 'completed', 'failed', 'cancelled'],
  waiting_approval: ['running', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
}

/** States a task can never leave once entered. */
export const TERMINAL_TASK_STATES: readonly TaskState[] = [
  'completed',
  'failed',
  'cancelled',
]

export class InvalidTaskTransitionError extends Error {
  constructor(
    readonly from: TaskState,
    readonly to: TaskState,
  ) {
    super(`Invalid task state transition '${from}' -> '${to}'`)
    this.name = 'InvalidTaskTransitionError'
  }
}

export function isTerminalTaskState(state: TaskState): boolean {
  return TASK_STATE_TRANSITIONS[state]!.length === 0
}

export function canTransitionTask(from: TaskState, to: TaskState): boolean {
  return TASK_STATE_TRANSITIONS[from]!.includes(to)
}

export function assertTaskTransition(from: TaskState, to: TaskState): void {
  if (!canTransitionTask(from, to)) {
    throw new InvalidTaskTransitionError(from, to)
  }
}
