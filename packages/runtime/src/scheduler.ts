import type { ChronicleStore } from '@bee-agent/knowledge'
import { ChronicleSequenceConflictError } from '@bee-agent/knowledge'
import type { NewChronicleEvent } from '@bee-agent/knowledge'
import type { AgentLoopRunInput, AgentLoopTurnResult } from './agent-loop.ts'
import {
  SCHEDULER_STREAM_ID,
  SchedulerTriggerSchema,
  UnknownSchedulerEventTypeError,
  schedulerTriggerRegisteredEvent,
  schedulerTriggerRemovedEvent,
  schedulerTriggerTriggeredEvent,
} from './scheduler-events.ts'
import type { SchedulerTrigger, SchedulerWhen } from './scheduler-events.ts'

/**
 * The durable agent scheduler (v1 refactor plan §5.5 WF4-F, architecture
 * §7.1): one-shot and recurring triggers that continue a bound thread across
 * days and restarts. State is the serialized `scheduler` Chronicle stream;
 * `rebuild` recovers it, and a tick fires every due trigger under a
 * fire-once catch-up policy — missed intervals collapse into one run that
 * reports how many were skipped while advancing the schedule on its original
 * cadence. Firing is at-least-once: the thread's turn history keeps any
 * crash-induced duplicate visible.
 */

/** The turn-driving surface the scheduler needs (AgentLoop services fit). */
export interface SchedulerTurnPort {
  runTurn(input: AgentLoopRunInput): Promise<AgentLoopTurnResult>
}

export interface AgentSchedulerOptions {
  readonly store: ChronicleStore
  readonly turns: SchedulerTurnPort
  readonly now?: (() => string) | undefined
  /** Auto-tick interval; absent means fully manual `tick()` calls. */
  readonly tickIntervalMs?: number | undefined
}

export interface RegisterSchedulerTriggerInput {
  readonly input: string
  readonly threadId: string
  readonly at?: string | undefined
  readonly intervalMs?: number | undefined
  /** Condition firing instead of a schedule; exclusive with at/intervalMs. */
  readonly when?: SchedulerWhen | undefined
}

export interface SchedulerFiredRun {
  readonly triggerId: string
  readonly threadId: string
  readonly turnId: string | undefined
  readonly status: 'completed' | 'failed' | 'cancelled' | 'suspended' | 'error'
  readonly missedIntervals: number
}

export interface SchedulerTickReport {
  readonly fired: readonly SchedulerFiredRun[]
}

export class SchedulerTriggerNotFoundError extends Error {
  constructor(readonly triggerId: string) {
    super(`Scheduler trigger '${triggerId}' was not found`)
    this.name = 'SchedulerTriggerNotFoundError'
  }
}

export class AgentScheduler {
  readonly #store: ChronicleStore
  readonly #turns: SchedulerTurnPort
  readonly #now: () => string
  readonly #tickIntervalMs: number | undefined
  readonly #triggers = new Map<string, SchedulerTrigger>()
  #timer: ReturnType<typeof setInterval> | undefined
  #tail: Promise<unknown> = Promise.resolve()

  constructor(options: AgentSchedulerOptions) {
    this.#store = options.store
    this.#turns = options.turns
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#tickIntervalMs = options.tickIntervalMs
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Replays the scheduler stream into the projection (restart recovery). */
  async rebuild(): Promise<void> {
    return this.#serialize(async () => {
      this.#triggers.clear()
      for await (const event of this.#store.readStream(SCHEDULER_STREAM_ID)) {
        switch (event.eventType) {
          case 'scheduler.trigger.registered': {
            const { trigger } = event.payload as { trigger: SchedulerTrigger }
            this.#triggers.set(trigger.id, trigger)
            continue
          }
          case 'scheduler.trigger.triggered': {
            const payload = event.payload as {
              triggerId: string
              nextRunAt?: string | undefined
            }
            const trigger = this.#triggers.get(payload.triggerId)
            if (trigger === undefined) continue
            if (trigger.when !== undefined) {
              this.#triggers.delete(trigger.id)
              continue
            }
            this.#triggers.set(trigger.id, {
              ...trigger,
              nextRunAt: payload.nextRunAt,
            })
            continue
          }
          case 'scheduler.trigger.removed': {
            const { triggerId } = event.payload as { triggerId: string }
            this.#triggers.delete(triggerId)
            continue
          }
          default:
            throw new UnknownSchedulerEventTypeError(event.eventType)
        }
      }
    })
  }

  /** Starts auto-ticking when an interval was configured. */
  start(): void {
    if (this.#timer !== undefined || this.#tickIntervalMs === undefined) return
    this.#timer = setInterval(() => {
      void this.tick()
    }, this.#tickIntervalMs)
  }

  stop(): void {
    if (this.#timer === undefined) return
    clearInterval(this.#timer)
    this.#timer = undefined
  }

  // -----------------------------------------------------------------------
  // Trigger management
  // -----------------------------------------------------------------------

  list(): readonly SchedulerTrigger[] {
    return [...this.#triggers.values()].sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )
  }

  async register(
    input: RegisterSchedulerTriggerInput,
  ): Promise<SchedulerTrigger> {
    if (
      input.intervalMs !== undefined &&
      (!Number.isInteger(input.intervalMs) || input.intervalMs < 1)
    ) {
      throw new Error('intervalMs must be a positive integer')
    }
    const hasSchedule = input.at !== undefined || input.intervalMs !== undefined
    if (input.when !== undefined && hasSchedule) {
      throw new Error('when is exclusive with at/intervalMs')
    }
    if (input.when === undefined && !hasSchedule) {
      throw new Error('a trigger needs at, intervalMs, or when')
    }
    const now = this.#now()
    const trigger = SchedulerTriggerSchema.parse({
      id: crypto.randomUUID(),
      input: input.input,
      threadId: input.threadId,
      ...(input.at === undefined ? {} : { at: input.at }),
      ...(input.intervalMs === undefined
        ? {}
        : { intervalMs: input.intervalMs }),
      ...(input.when === undefined ? {} : { when: input.when }),
      enabled: true,
      createdAt: now,
      ...(input.when === undefined ? { nextRunAt: input.at ?? now } : {}),
    })
    await this.#append([schedulerTriggerRegisteredEvent(trigger)])
    this.#triggers.set(trigger.id, trigger)
    return trigger
  }

  async remove(triggerId: string, reason?: string): Promise<void> {
    const trigger = this.#triggers.get(triggerId)
    if (trigger === undefined)
      throw new SchedulerTriggerNotFoundError(triggerId)
    await this.#append([
      schedulerTriggerRemovedEvent(
        {
          triggerId,
          ...(reason !== undefined ? { reason } : {}),
        },
        trigger.threadId,
      ),
    ])
    this.#triggers.delete(triggerId)
  }

  // -----------------------------------------------------------------------
  // Firing
  // -----------------------------------------------------------------------

  /** Fires every due trigger once; serialized and safe to call any time. */
  tick(): Promise<SchedulerTickReport> {
    return this.#serialize(() => this.#tickNow())
  }

  async #tickNow(): Promise<SchedulerTickReport> {
    const now = this.#now()
    const fired: SchedulerFiredRun[] = []
    const due = [...this.#triggers.values()]
      .filter(
        (trigger) =>
          trigger.enabled &&
          trigger.when === undefined &&
          trigger.nextRunAt !== undefined &&
          trigger.nextRunAt <= now,
      )
      .sort(
        (a, b) =>
          (a.nextRunAt ?? '').localeCompare(b.nextRunAt ?? '') ||
          a.id.localeCompare(b.id),
      )
    for (const trigger of due) {
      fired.push(await this.#fire(trigger, now))
    }
    // Dependency triggers: evaluate pending task conditions against the
    // durable kanban stream, so transitions missed while down still fire.
    for (const trigger of this.#pendingTaskTriggers()) {
      const satisfied = await this.#taskReachedStatus(
        trigger.when!.taskStatus!,
        trigger.createdAt,
      )
      if (satisfied) fired.push(await this.#fire(trigger, now))
    }
    return { fired }
  }

  *#pendingTaskTriggers(): Generator<SchedulerTrigger> {
    for (const trigger of this.#triggers.values()) {
      if (!trigger.enabled || trigger.nextRunAt !== undefined) continue
      if (trigger.when?.taskStatus === undefined) continue
      yield trigger
    }
  }

  async #taskReachedStatus(
    condition: { taskId: string; status: string },
    since: string,
  ): Promise<boolean> {
    for await (const event of this.#store.readStream(
      `kanban:${condition.taskId}`,
    )) {
      if (event.eventType !== 'kanban.task.status_changed') continue
      if (event.ingestTime <= since) continue
      const payload = event.payload as {
        task: { id: string; status: string }
      }
      if (
        payload.task.id === condition.taskId &&
        payload.task.status === condition.status
      ) {
        return true
      }
    }
    return false
  }

  /**
   * Edge notification for `when.event` triggers: the Host forwards appended
   * events; a match fires the trigger once. Not replayed across restarts.
   */
  notify(event: {
    streamId: string
    eventType: string
  }): Promise<SchedulerFiredRun | undefined> {
    return this.#serialize(async () => {
      const now = this.#now()
      for (const trigger of this.#triggers.values()) {
        if (!trigger.enabled || trigger.nextRunAt !== undefined) continue
        const condition = trigger.when?.event
        if (condition === undefined) continue
        if (event.eventType !== condition.eventType) continue
        if (
          condition.streamPrefix !== undefined &&
          !event.streamId.startsWith(condition.streamPrefix)
        ) {
          continue
        }
        return this.#fire(trigger, now)
      }
      return undefined
    })
  }

  async #fire(
    trigger: SchedulerTrigger,
    now: string,
  ): Promise<SchedulerFiredRun> {
    const missedIntervals =
      trigger.intervalMs === undefined || trigger.nextRunAt === undefined
        ? 0
        : Math.max(
            0,
            Math.floor(
              (Date.parse(now) - Date.parse(trigger.nextRunAt)) /
                trigger.intervalMs,
            ),
          )

    let run: SchedulerFiredRun
    try {
      const result = await this.#turns.runTurn({
        threadId: trigger.threadId,
        input: trigger.input,
        trigger: 'schedule',
      })
      run = {
        triggerId: trigger.id,
        threadId: trigger.threadId,
        turnId: result.turn.id,
        status: result.status,
        missedIntervals,
      }
    } catch (error) {
      // A crashing turn still advances the schedule: without this, a
      // persistent error would hot-loop the trigger on every tick.
      run = {
        triggerId: trigger.id,
        threadId: trigger.threadId,
        turnId: undefined,
        status: 'error',
        missedIntervals,
      }
      void error
    }

    const following =
      trigger.intervalMs === undefined || trigger.nextRunAt === undefined
        ? undefined
        : new Date(
            Math.max(
              Date.parse(trigger.nextRunAt) +
                (missedIntervals + 1) * trigger.intervalMs,
              Date.parse(now) + trigger.intervalMs,
            ),
          ).toISOString()

    await this.#append([
      schedulerTriggerTriggeredEvent({
        triggerId: trigger.id,
        threadId: trigger.threadId,
        ...(run.turnId === undefined ? {} : { turnId: run.turnId }),
        status: run.status,
        firedAt: now,
        missedIntervals,
        ...(following === undefined ? {} : { nextRunAt: following }),
      }),
    ])
    if (trigger.when !== undefined) {
      // Condition triggers are one-shot: once fired they leave the active
      // projection (the triggered event keeps the audit trail).
      this.#triggers.delete(trigger.id)
    } else {
      this.#triggers.set(trigger.id, { ...trigger, nextRunAt: following })
    }
    return run
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  async #append(events: readonly NewChronicleEvent[]): Promise<void> {
    if (events.length === 0) return
    for (let attempt = 0; ; attempt += 1) {
      const expected =
        (await this.#store.getLatestSequence(SCHEDULER_STREAM_ID)) + 1
      try {
        await this.#store.append(SCHEDULER_STREAM_ID, events, {
          expectedSequence: expected,
        })
        return
      } catch (error) {
        if (error instanceof ChronicleSequenceConflictError && attempt < 2) {
          continue
        }
        throw error
      }
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(operation, operation)
    this.#tail = run.catch(() => undefined)
    return run
  }
}
