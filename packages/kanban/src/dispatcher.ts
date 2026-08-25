import type { KanbanTask, KanbanTaskId } from './protocol.ts'
import type { KanbanStore } from './store.ts'
import { KanbanLeaseLostError, KanbanTaskNotFoundError } from './store.ts'

/**
 * The Kanban dispatcher (architecture §15.3, v1 refactor plan §5.2 P2-2):
 * schedules ready tasks, claims them with a renewable lease, reclaims
 * expired leases, and completes/fails/block/cancels on behalf of a worker.
 * The Host drives these methods from its loop; nothing here is a background
 * thread, so every path is deterministic and injectable.
 */

export interface KanbanDispatcherOptions {
  readonly leaseDurationMs: number
  /** Max tasks one worker may hold in `running` at once (backpressure). */
  readonly maxConcurrent?: number | undefined
}

export class KanbanDispatcher {
  readonly #store: KanbanStore
  readonly #leaseDurationMs: number
  readonly #maxConcurrent: number

  constructor(store: KanbanStore, options: KanbanDispatcherOptions) {
    this.#store = store
    this.#leaseDurationMs = options.leaseDurationMs
    this.#maxConcurrent = options.maxConcurrent ?? 1
  }

  /** Ready tasks whose schedule is due and whose blocking deps are satisfied. */
  async readyTasks(now = new Date().toISOString()): Promise<KanbanTask[]> {
    const ready = await this.#store.list({
      status: 'ready',
      scheduledBefore: now,
    })
    const runnable: KanbanTask[] = []
    for (const task of ready) {
      if (await this.#dependenciesSatisfied(task)) runnable.push(task)
    }
    return runnable
  }

  /**
   * Claims the highest-priority runnable task for `workerId`, or undefined
   * when nothing is runnable or the worker is at its concurrency limit.
   * Concurrent claims surface `KanbanVersionConflictError` from the store.
   */
  async claimNext(
    workerId: string,
    now = new Date().toISOString(),
  ): Promise<KanbanTask | undefined> {
    if (!(await this.#hasCapacity(workerId))) return undefined
    const ready = await this.readyTasks(now)
    const task = ready[0]
    if (task === undefined) return undefined
    const leaseId = crypto.randomUUID()
    return this.#store.transition(task.id, {
      to: 'running',
      expectedVersion: task.version,
      at: now,
      claim: {
        claimant: workerId,
        leaseId,
        claimedAt: now,
        expiresAt: this.#expiry(now),
      },
    })
  }

  /** Renews a lease the caller still holds; fails after a reclaim. */
  async heartbeat(
    taskId: KanbanTaskId,
    leaseId: string,
    now = new Date().toISOString(),
  ): Promise<KanbanTask> {
    return this.#store.renewLease(taskId, {
      leaseId,
      expiresAt: this.#expiry(now),
    })
  }

  /** Releases every running task whose lease has lapsed, back to `ready`. */
  async reclaimExpired(
    now = new Date().toISOString(),
  ): Promise<KanbanTaskId[]> {
    const running = await this.#store.list({ status: 'running' })
    const reclaimed: KanbanTaskId[] = []
    for (const task of running) {
      if (task.claim !== undefined && task.claim.expiresAt <= now) {
        await this.#store.transition(task.id, {
          to: 'ready',
          expectedVersion: task.version,
          at: now,
        })
        reclaimed.push(task.id)
      }
    }
    return reclaimed
  }

  async complete(
    taskId: KanbanTaskId,
    leaseId: string,
    now = new Date().toISOString(),
  ): Promise<KanbanTask> {
    const task = await this.#owned(taskId, leaseId)
    return this.#store.transition(taskId, {
      to: 'done',
      expectedVersion: task.version,
      at: now,
    })
  }

  async fail(
    taskId: KanbanTaskId,
    leaseId: string,
    reason?: string | undefined,
    now = new Date().toISOString(),
  ): Promise<KanbanTask> {
    const task = await this.#owned(taskId, leaseId)
    return this.#store.transition(taskId, {
      to: 'failed',
      expectedVersion: task.version,
      at: now,
      reason,
    })
  }

  async block(
    taskId: KanbanTaskId,
    leaseId: string,
    reason?: string | undefined,
    now = new Date().toISOString(),
  ): Promise<KanbanTask> {
    const task = await this.#owned(taskId, leaseId)
    return this.#store.transition(taskId, {
      to: 'blocked',
      expectedVersion: task.version,
      at: now,
      reason,
    })
  }

  async cancel(
    taskId: KanbanTaskId,
    now = new Date().toISOString(),
  ): Promise<KanbanTask> {
    const task = await this.#store.get(taskId)
    if (task === undefined) throw new KanbanTaskNotFoundError(taskId)
    return this.#store.transition(taskId, {
      to: 'cancelled',
      expectedVersion: task.version,
      at: now,
    })
  }

  #expiry(now: string): string {
    return new Date(Date.parse(now) + this.#leaseDurationMs).toISOString()
  }

  async #hasCapacity(workerId: string): Promise<boolean> {
    if (this.#maxConcurrent <= 0) return true
    const running = await this.#store.list({ status: 'running' })
    const mine = running.filter((task) => task.claim?.claimant === workerId)
    return mine.length < this.#maxConcurrent
  }

  async #owned(taskId: KanbanTaskId, leaseId: string): Promise<KanbanTask> {
    const task = await this.#store.get(taskId)
    if (task === undefined) throw new KanbanTaskNotFoundError(taskId)
    if (task.status !== 'running' || task.claim?.leaseId !== leaseId) {
      throw new KanbanLeaseLostError(taskId, leaseId)
    }
    return task
  }

  async #dependenciesSatisfied(task: KanbanTask): Promise<boolean> {
    for (const dependency of task.dependencies) {
      if (dependency.kind !== 'blocks') continue
      const dependencyTask = await this.#store.get(dependency.taskId)
      const satisfiedWhen = dependency.satisfiedWhen ?? 'done'
      if (
        dependencyTask === undefined ||
        dependencyTask.status !== satisfiedWhen
      ) {
        return false
      }
    }
    return true
  }
}
