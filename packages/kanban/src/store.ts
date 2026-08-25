import type {
  ChronicleEvent,
  ChronicleStore,
  NewChronicleEvent,
} from '@bee-agent/knowledge'
import { newKanbanTask } from './construct.ts'
import type { NewKanbanTaskInit } from './construct.ts'
import {
  kanbanStreamId,
  kanbanTaskCommentedEvent,
  kanbanTaskCreatedEvent,
  kanbanTaskLeaseRenewedEvent,
  kanbanTaskStatusChangedEvent,
  kanbanTaskUpdatedEvent,
  UnknownKanbanTaskEventTypeError,
} from './events.ts'
import { KanbanTaskSchema } from './protocol.ts'
import type {
  KanbanComment,
  KanbanPriority,
  KanbanTask,
  KanbanTaskId,
  KanbanTaskStatus,
} from './protocol.ts'
import {
  applyTransition,
  KanbanVersionConflictError,
  type KanbanTransitionCommand,
} from './state-machine.ts'

/**
 * The Kanban store contract (architecture §15.1, v1 refactor plan §5.2
 * P2-2): a queryable projection over the Chronicle event log. Every write
 * appends a durable event and advances the projection in one step; writes
 * are guarded by the aggregate `version` (expected-version) and, underneath,
 * by the stream `sequence`. `rebuild()` replays the log so a Host restart
 * recovers the board without any in-memory state.
 */

export class KanbanTaskNotFoundError extends Error {
  constructor(readonly taskId: KanbanTaskId) {
    super(`Kanban task '${taskId}' was not found`)
    this.name = 'KanbanTaskNotFoundError'
  }
}

/** A lease-scoped operation failed because the caller no longer holds it. */
export class KanbanLeaseLostError extends Error {
  constructor(
    readonly taskId: KanbanTaskId,
    readonly leaseId: string,
  ) {
    super(`Kanban task '${taskId}' is not held under lease '${leaseId}'`)
    this.name = 'KanbanLeaseLostError'
  }
}

export interface KanbanTaskQuery {
  readonly status?: KanbanTaskStatus | readonly KanbanTaskStatus[] | undefined
  /** Match tasks carrying any of these labels. */
  readonly labels?: readonly string[] | undefined
  readonly priority?: KanbanPriority | undefined
  /** Only tasks with `scheduledAt` absent or at/before this time. */
  readonly scheduledBefore?: string | undefined
  readonly limit?: number | undefined
}

export interface KanbanLeaseRenewal {
  readonly leaseId: string
  readonly expiresAt: string
}

/** A field-only mutation: only provided fields change, none of them status. */
export interface KanbanTaskUpdate {
  readonly expectedVersion: number
  readonly at?: string | undefined
  readonly title?: string | undefined
  readonly goal?: string | undefined
  readonly acceptanceCriteria?: readonly string[] | undefined
  readonly priority?: KanbanPriority | undefined
  readonly labels?: readonly string[] | undefined
  readonly deadline?: string | undefined
  readonly scheduledAt?: string | undefined
}

export interface KanbanCommentInput {
  readonly author: string
  readonly body: string
  readonly at?: string | undefined
}

export interface KanbanStore {
  get(taskId: KanbanTaskId): Promise<KanbanTask | undefined>

  list(query?: KanbanTaskQuery): Promise<KanbanTask[]>

  /**
   * Creates a task at version 1. When `init.idempotencyKey` is set and a
   * task with that key already exists, the existing task is returned instead
   * of a duplicate (idempotent retry).
   */
  create(init: NewKanbanTaskInit): Promise<KanbanTask>

  /**
   * Applies one status transition guarded by `command.expectedVersion`.
   * Throws {@link KanbanVersionConflictError} / {@link KanbanInvalidTransitionError}
   * on a stale or illegal move.
   */
  transition(
    taskId: KanbanTaskId,
    command: KanbanTransitionCommand,
  ): Promise<KanbanTask>

  /** Extends a running task's lease; fails when the lease id no longer matches. */
  renewLease(
    taskId: KanbanTaskId,
    renewal: KanbanLeaseRenewal,
  ): Promise<KanbanTask>

  /** Updates fields without changing status, guarded by expected-version. */
  update(taskId: KanbanTaskId, patch: KanbanTaskUpdate): Promise<KanbanTask>

  /** Appends a comment, advancing the version without changing status. */
  comment(taskId: KanbanTaskId, input: KanbanCommentInput): Promise<KanbanTask>

  /** Replays the log into the projection (restart recovery). */
  rebuild(): Promise<void>

  close(): Promise<void>
}

const PRIORITY_ORDER: Record<KanbanPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  lowest: 4,
}

function compareOptionalDate(a?: string, b?: string): number {
  if (a === undefined && b === undefined) return 0
  if (a === undefined) return 1
  if (b === undefined) return -1
  return a.localeCompare(b)
}

/** Highest priority first, then soonest deadline, then soonest schedule. */
function compareTasks(a: KanbanTask, b: KanbanTask): number {
  const byPriority = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
  if (byPriority !== 0) return byPriority
  const byDeadline = compareOptionalDate(a.deadline, b.deadline)
  if (byDeadline !== 0) return byDeadline
  const bySchedule = compareOptionalDate(a.scheduledAt, b.scheduledAt)
  if (bySchedule !== 0) return bySchedule
  return a.createdAt.localeCompare(b.createdAt)
}

/** Folds one event into the projected task for a given stream. */
function foldTask(
  task: KanbanTask | undefined,
  event: ChronicleEvent,
): KanbanTask {
  switch (event.eventType) {
    case 'kanban.task.created': {
      const payload = event.payload as { task: KanbanTask }
      return payload.task
    }
    case 'kanban.task.status_changed': {
      const payload = event.payload as { task: KanbanTask }
      return payload.task
    }
    case 'kanban.task.updated': {
      const payload = event.payload as { task: KanbanTask }
      return payload.task
    }
    case 'kanban.task.commented': {
      if (task === undefined) {
        throw new Error('Kanban task stream has a commented before created')
      }
      const { comment } = event.payload as { comment: KanbanComment }
      return {
        ...task,
        comments: [...task.comments, comment],
        version: task.version + 1,
      }
    }
    case 'kanban.task.lease_renewed': {
      if (task === undefined) {
        throw new Error('Kanban task stream has a lease_renewed before created')
      }
      const payload = event.payload as { leaseId: string; expiresAt: string }
      // A renewal is only meaningful for a live lease we still hold; stale
      // renewals (after a reclaim) are ignored so replay stays deterministic.
      if (
        task.status !== 'running' ||
        task.claim?.leaseId !== payload.leaseId
      ) {
        return task
      }
      return {
        ...task,
        claim: { ...task.claim, expiresAt: payload.expiresAt },
        version: task.version + 1,
      }
    }
    default:
      throw new UnknownKanbanTaskEventTypeError(event.eventType)
  }
}

/**
 * The dialect-agnostic Kanban store: an in-memory projection kept in sync
 * with the Chronicle event log and rebuilt from it on {@link rebuild}. Back
 * it with any {@link ChronicleStore} — the memory store for tests, the
 * SQLite store for the default embedded host.
 */
export class ChronicleKanbanStore implements KanbanStore {
  readonly #chronicle: ChronicleStore
  readonly #tasks = new Map<string, KanbanTask>()
  readonly #idempotency = new Map<string, KanbanTaskId>()

  constructor(chronicle: ChronicleStore) {
    this.#chronicle = chronicle
  }

  async get(taskId: KanbanTaskId): Promise<KanbanTask | undefined> {
    return this.#tasks.get(taskId)
  }

  async list(query: KanbanTaskQuery = {}): Promise<KanbanTask[]> {
    let tasks = [...this.#tasks.values()]
    if (query.status !== undefined) {
      const statuses = new Set(
        Array.isArray(query.status) ? query.status : [query.status],
      )
      tasks = tasks.filter((task) => statuses.has(task.status))
    }
    if (query.labels !== undefined && query.labels.length > 0) {
      tasks = tasks.filter((task) =>
        query.labels!.some((label) => task.labels.includes(label)),
      )
    }
    if (query.priority !== undefined) {
      tasks = tasks.filter((task) => task.priority === query.priority)
    }
    if (query.scheduledBefore !== undefined) {
      tasks = tasks.filter(
        (task) =>
          task.scheduledAt === undefined ||
          task.scheduledAt <= query.scheduledBefore!,
      )
    }
    tasks.sort(compareTasks)
    return query.limit === undefined ? tasks : tasks.slice(0, query.limit)
  }

  async create(init: NewKanbanTaskInit): Promise<KanbanTask> {
    if (init.idempotencyKey !== undefined) {
      const existingId = this.#idempotency.get(init.idempotencyKey)
      const existing =
        existingId === undefined ? undefined : this.#tasks.get(existingId)
      if (existing !== undefined) return existing
    }
    const task = newKanbanTask(init)
    await this.#commit(task.id, [kanbanTaskCreatedEvent(task)], 1, task)
    return task
  }

  async transition(
    taskId: KanbanTaskId,
    command: KanbanTransitionCommand,
  ): Promise<KanbanTask> {
    const current = this.#tasks.get(taskId)
    if (current === undefined) throw new KanbanTaskNotFoundError(taskId)
    const next = applyTransition(current, command)
    await this.#commit(
      taskId,
      [
        kanbanTaskStatusChangedEvent({
          from: current.status,
          task: next,
          reason: command.reason,
        }),
      ],
      command.expectedVersion + 1,
      next,
    )
    return next
  }

  async renewLease(
    taskId: KanbanTaskId,
    renewal: KanbanLeaseRenewal,
  ): Promise<KanbanTask> {
    const current = this.#tasks.get(taskId)
    if (current === undefined) throw new KanbanTaskNotFoundError(taskId)
    if (
      current.status !== 'running' ||
      current.claim?.leaseId !== renewal.leaseId
    ) {
      throw new KanbanLeaseLostError(taskId, renewal.leaseId)
    }
    const next: KanbanTask = {
      ...current,
      claim: { ...current.claim!, expiresAt: renewal.expiresAt },
      version: current.version + 1,
    }
    await this.#commit(
      taskId,
      [kanbanTaskLeaseRenewedEvent({ taskId, ...renewal })],
      current.version + 1,
      next,
    )
    return next
  }

  async update(
    taskId: KanbanTaskId,
    patch: KanbanTaskUpdate,
  ): Promise<KanbanTask> {
    const current = this.#tasks.get(taskId)
    if (current === undefined) throw new KanbanTaskNotFoundError(taskId)
    if (patch.expectedVersion !== current.version) {
      throw new KanbanVersionConflictError(
        taskId,
        patch.expectedVersion,
        current.version,
      )
    }
    const at = patch.at ?? new Date().toISOString()
    const next = KanbanTaskSchema.parse({
      ...current,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.goal !== undefined ? { goal: patch.goal } : {}),
      ...(patch.acceptanceCriteria !== undefined
        ? { acceptanceCriteria: [...patch.acceptanceCriteria] }
        : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.labels !== undefined ? { labels: [...patch.labels] } : {}),
      ...(patch.deadline !== undefined ? { deadline: patch.deadline } : {}),
      ...(patch.scheduledAt !== undefined
        ? { scheduledAt: patch.scheduledAt }
        : {}),
      version: current.version + 1,
      updatedAt: at,
    })
    await this.#commit(
      taskId,
      [kanbanTaskUpdatedEvent(next)],
      current.version + 1,
      next,
    )
    return next
  }

  async comment(
    taskId: KanbanTaskId,
    input: KanbanCommentInput,
  ): Promise<KanbanTask> {
    const current = this.#tasks.get(taskId)
    if (current === undefined) throw new KanbanTaskNotFoundError(taskId)
    const comment: KanbanComment = {
      id: crypto.randomUUID(),
      author: input.author,
      body: input.body,
      at: input.at ?? new Date().toISOString(),
    }
    const next: KanbanTask = {
      ...current,
      comments: [...current.comments, comment],
      version: current.version + 1,
      updatedAt: comment.at,
    }
    await this.#commit(
      taskId,
      [kanbanTaskCommentedEvent({ taskId, comment })],
      current.version + 1,
      next,
    )
    return next
  }

  async rebuild(): Promise<void> {
    this.#tasks.clear()
    this.#idempotency.clear()
    for (const streamId of await this.#chronicle.listStreams()) {
      if (!streamId.startsWith('kanban:')) continue
      let task: KanbanTask | undefined
      for await (const event of this.#chronicle.readStream(streamId)) {
        task = foldTask(task, event)
      }
      if (task !== undefined) this.#index(task)
    }
  }

  async close(): Promise<void> {
    this.#tasks.clear()
    this.#idempotency.clear()
  }

  /**
   * Appends events at the sequence implied by the task version (which always
   * equals the stream length: `created` is version 1/sequence 1, and every
   * later mutation advances both). Tying the sequence to the observed version
   * makes a concurrent write on the same task a hard conflict, not a second
   * successful append.
   */
  async #commit(
    taskId: KanbanTaskId,
    events: readonly NewChronicleEvent[],
    expectedSequence: number,
    next: KanbanTask,
  ): Promise<void> {
    await this.#chronicle.append(kanbanStreamId(taskId), events, {
      expectedSequence,
    })
    this.#index(next)
  }

  #index(task: KanbanTask): void {
    this.#tasks.set(task.id, task)
    if (task.idempotencyKey !== undefined) {
      this.#idempotency.set(task.idempotencyKey, task.id)
    }
  }
}
