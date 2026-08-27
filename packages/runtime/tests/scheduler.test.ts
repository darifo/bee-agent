import { describe, expect, it } from 'vitest'
import { ChronicleSchemaRegistry } from '@bee-agent/knowledge'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'
import {
  AgentScheduler,
  SchedulerTriggerNotFoundError,
} from '../src/scheduler.ts'
import type { SchedulerTurnPort } from '../src/scheduler.ts'
import { registerSchedulerChronicleEvents } from '../src/scheduler-events.ts'
import type {
  AgentLoopRunInput,
  AgentLoopTurnResult,
} from '../src/agent-loop.ts'

function createStore(): MemoryChronicleStore {
  const registry = new ChronicleSchemaRegistry()
  registerSchedulerChronicleEvents(registry)
  return new MemoryChronicleStore(registry)
}

/** Fake clock: milliseconds since the epoch, ISO-formatted. */
function clock(startMs = Date.parse('2026-01-01T00:00:00Z')) {
  let ms = startMs
  return {
    now: () => new Date(ms).toISOString(),
    advance: (delta: number) => {
      ms += delta
    },
    set: (value: number) => {
      ms = value
    },
  }
}

interface RecordedRun {
  readonly input: AgentLoopRunInput
  resolve(result: AgentLoopTurnResult): void
}

/** Scripted turn port recording runs; resolves with a queued result. */
function scriptedTurns(
  results: ReadonlyArray<
    () => AgentLoopTurnResult | Promise<AgentLoopTurnResult>
  >,
): { port: SchedulerTurnPort; runs: RecordedRun[] } {
  const runs: RecordedRun[] = []
  let index = 0
  return {
    runs,
    port: {
      runTurn(input) {
        const record = {} as RecordedRun
        const promise = new Promise<AgentLoopTurnResult>((resolve) => {
          Object.assign(record, {
            input,
            resolve: (result: AgentLoopTurnResult) => resolve(result),
          })
          runs.push(record)
        })
        const script = results[Math.min(index, results.length - 1)]!
        index += 1
        void Promise.resolve(script()).then((result) => {
          record.resolve(result)
        })
        return promise
      },
    },
  }
}

function completedTurn(threadId: string): AgentLoopTurnResult {
  return {
    status: 'completed',
    output: 'ok',
    turn: {
      id: crypto.randomUUID(),
      threadId,
      status: 'completed',
      trigger: 'schedule',
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:00:01Z',
    },
  }
}

describe('AgentScheduler', () => {
  it('fires one-shot triggers once at their due time', async () => {
    const store = createStore()
    const time = clock()
    const { port, runs } = scriptedTurns([() => completedTurn('t')])
    const scheduler = new AgentScheduler({ store, turns: port, now: time.now })
    await scheduler.rebuild()

    const threadId = crypto.randomUUID()
    const trigger = await scheduler.register({
      input: 'Daily digest',
      threadId,
      at: new Date(Date.parse(time.now()) + 60_000).toISOString(),
    })

    // Before the due time: nothing fires.
    expect((await scheduler.tick()).fired).toEqual([])
    expect(runs).toHaveLength(0)

    time.advance(60_000)
    const report = await scheduler.tick()
    expect(report.fired).toHaveLength(1)
    expect(report.fired[0]).toMatchObject({
      triggerId: trigger.id,
      status: 'completed',
      missedIntervals: 0,
    })
    expect(runs[0]!.input).toMatchObject({ threadId, input: 'Daily digest' })

    // One-shot triggers are exhausted after firing.
    expect((await scheduler.tick()).fired).toEqual([])
    expect((await scheduler.list())[0]!.nextRunAt).toBeUndefined()
    await store.close()
  })

  it('advances recurring triggers on their original cadence', async () => {
    const store = createStore()
    const time = clock()
    const { port, runs } = scriptedTurns([() => completedTurn('t')])
    const scheduler = new AgentScheduler({ store, turns: port, now: time.now })
    await scheduler.rebuild()
    const threadId = crypto.randomUUID()

    await scheduler.register({
      input: 'Heartbeat',
      threadId,
      intervalMs: 3_600_000,
    })
    const report = await scheduler.tick()
    expect(report.fired).toHaveLength(1)

    const next = (await scheduler.list())[0]!.nextRunAt!
    expect(next).toBe(
      new Date(Date.parse(time.now()) + 3_600_000).toISOString(),
    )

    // Not due again before the interval elapses.
    time.advance(3_599_999)
    expect((await scheduler.tick()).fired).toEqual([])
    time.advance(1)
    expect((await scheduler.tick()).fired).toHaveLength(1)
    expect(runs).toHaveLength(2)
    await store.close()
  })

  it('collapses missed intervals during downtime into one catch-up run', async () => {
    const store = createStore()
    const time = clock()
    const { port, runs } = scriptedTurns([() => completedTurn('t')])
    const scheduler = new AgentScheduler({ store, turns: port, now: time.now })
    await scheduler.rebuild()
    const threadId = crypto.randomUUID()
    await scheduler.register({
      input: 'Hourly sync',
      threadId,
      intervalMs: 3_600_000,
    })
    await scheduler.tick()

    // Simulate six hours of downtime: the next run is long overdue.
    time.advance(6 * 3_600_000)
    const report = await scheduler.tick()
    expect(report.fired).toHaveLength(1)
    expect(report.fired[0]!.missedIntervals).toBe(5)
    expect(runs).toHaveLength(2)

    // The schedule resumes on its original cadence from the missed slot:
    // after the catch-up run, the next due time is one interval past now.
    const next = (await scheduler.list())[0]!.nextRunAt!
    const expected = Date.parse(time.now()) + 3_600_000
    expect(Date.parse(next)).toBe(expected)
    await store.close()
  })

  it('advances the schedule even when the turn throws', async () => {
    const store = createStore()
    const time = clock()
    const { port } = scriptedTurns([
      () => {
        throw new Error('loop exploded')
      },
    ])
    const scheduler = new AgentScheduler({ store, turns: port, now: time.now })
    await scheduler.rebuild()
    const threadId = crypto.randomUUID()
    await scheduler.register({ input: 'Risky', threadId, intervalMs: 60_000 })

    const report = await scheduler.tick()
    expect(report.fired[0]).toMatchObject({ status: 'error' })
    expect((await scheduler.list())[0]!.nextRunAt).toBeDefined()
    // No hot loop: the error does not refire on the immediate next tick.
    expect((await scheduler.tick()).fired).toEqual([])
    await store.close()
  })

  it('removes triggers durably and recovers state after restart', async () => {
    const store = createStore()
    const time = clock()
    const { port, runs } = scriptedTurns([() => completedTurn('t')])
    const scheduler = new AgentScheduler({ store, turns: port, now: time.now })
    await scheduler.rebuild()
    const threadId = crypto.randomUUID()

    const kept = await scheduler.register({
      input: 'Keep',
      threadId,
      intervalMs: 60_000,
    })
    const dropped = await scheduler.register({
      input: 'Drop',
      threadId,
      intervalMs: 60_000,
    })
    await scheduler.tick()
    await scheduler.remove(dropped.id, 'user removed it')
    await expect(scheduler.remove(dropped.id)).rejects.toBeInstanceOf(
      SchedulerTriggerNotFoundError,
    )

    const restarted = new AgentScheduler({
      store,
      turns: port,
      now: time.now,
    })
    await restarted.rebuild()
    expect(restarted.list().map((trigger) => trigger.id)).toEqual([kept.id])

    // The restarted schedule keeps firing the surviving trigger. (The first
    // tick fired both registered triggers, so this is the third run.)
    time.advance(60_000)
    expect((await restarted.tick()).fired).toHaveLength(1)
    expect(runs).toHaveLength(3)
    await store.close()
  })

  it('rejects invalid intervals', async () => {
    const store = createStore()
    const { port } = scriptedTurns([() => completedTurn('t')])
    const scheduler = new AgentScheduler({ store, turns: port })
    await scheduler.rebuild()
    await expect(
      scheduler.register({
        input: 'x',
        threadId: crypto.randomUUID(),
        intervalMs: 0,
      }),
    ).rejects.toThrow(/intervalMs/)
    await store.close()
  })
})
