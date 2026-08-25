import { describe, expect, it } from 'vitest'
import { ChronicleSchemaRegistry } from '@bee-agent/knowledge'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'
import {
  ChronicleKanbanStore,
  KanbanDispatcher,
  registerKanbanChronicleEvents,
} from '../src/index.ts'
import type {
  KanbanStore,
  KanbanTask,
  NewKanbanTaskInit,
} from '../src/index.ts'

const T0 = '2026-08-25T10:00:00.000Z'
const T1 = '2026-08-25T10:01:00.000Z'
const T1_5 = '2026-08-25T10:01:30.000Z'
const T2 = '2026-08-25T10:02:00.000Z'

function createRegistry(): ChronicleSchemaRegistry {
  const registry = new ChronicleSchemaRegistry()
  registerKanbanChronicleEvents(registry)
  return registry
}

function createStore(): KanbanStore {
  return new ChronicleKanbanStore(new MemoryChronicleStore(createRegistry()))
}

function createDispatcher(
  store: KanbanStore,
  options: { leaseDurationMs?: number; maxConcurrent?: number } = {},
): KanbanDispatcher {
  return new KanbanDispatcher(store, { leaseDurationMs: 60_000, ...options })
}

/** Creates a task and moves it through inbox → triaged → ready. */
async function createReadyTask(
  store: KanbanStore,
  overrides: Partial<NewKanbanTaskInit> = {},
): Promise<KanbanTask> {
  const task = await store.create({ title: 'Task', now: T0, ...overrides })
  await store.transition(task.id, { to: 'triaged', expectedVersion: 1, at: T0 })
  return store.transition(task.id, { to: 'ready', expectedVersion: 2, at: T0 })
}

describe('KanbanDispatcher', () => {
  it('claims, heartbeats, and completes a task', async () => {
    const store = createStore()
    const dispatcher = createDispatcher(store)
    const task = await createReadyTask(store)

    const claimed = await dispatcher.claimNext('worker-1', T0)
    expect(claimed?.id).toBe(task.id)
    expect(claimed?.status).toBe('running')
    expect(claimed?.claim?.claimant).toBe('worker-1')
    expect(claimed?.claim?.expiresAt).toBe(T1)

    const leaseId = claimed!.claim!.leaseId
    const renewed = await dispatcher.heartbeat(task.id, leaseId, T1)
    expect(renewed.claim?.expiresAt).toBe(T2)

    const done = await dispatcher.complete(task.id, leaseId, T2)
    expect(done.status).toBe('done')
    expect(done.endedAt).toBe(T2)
  })

  it('rejects a duplicate claim', async () => {
    const store = createStore()
    const dispatcher = createDispatcher(store)
    await createReadyTask(store)

    const results = await Promise.allSettled([
      dispatcher.claimNext('worker-1', T0),
      dispatcher.claimNext('worker-2', T0),
    ])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    expect(fulfilled).toHaveLength(1)

    const running = await store.list({ status: 'running' })
    expect(running).toHaveLength(1)
  })

  it('reclaims a task whose lease expired', async () => {
    const store = createStore()
    const dispatcher = createDispatcher(store)
    const task = await createReadyTask(store)
    await dispatcher.claimNext('worker-1', T0)

    const reclaimed = await dispatcher.reclaimExpired(T2)
    expect(reclaimed).toEqual([task.id])

    const after = await store.get(task.id)
    expect(after?.status).toBe('ready')
    expect(after?.claim).toBeUndefined()
  })

  it('keeps a heartbeated task claimed past its original expiry', async () => {
    const store = createStore()
    const dispatcher = createDispatcher(store)
    const task = await createReadyTask(store)
    const claimed = await dispatcher.claimNext('worker-1', T0)
    const leaseId = claimed!.claim!.leaseId

    await dispatcher.heartbeat(task.id, leaseId, T1)

    const reclaimed = await dispatcher.reclaimExpired(T1_5)
    expect(reclaimed).toEqual([])
    expect((await store.get(task.id))?.status).toBe('running')
  })

  it('recovers a task abandoned by a killed worker', async () => {
    const store = createStore()
    const dispatcher = createDispatcher(store)
    const task = await createReadyTask(store)
    await dispatcher.claimNext('worker-1', T0)

    // The worker dies without heartbeating; at T2 its lease has lapsed.
    const reclaimed = await dispatcher.reclaimExpired(T2)
    expect(reclaimed).toEqual([task.id])

    const reClaimed = await dispatcher.claimNext('worker-2', T2)
    expect(reClaimed?.id).toBe(task.id)
    expect(reClaimed?.claim?.claimant).toBe('worker-2')
  })

  it('respects the per-worker concurrency limit', async () => {
    const store = createStore()
    const dispatcher = createDispatcher(store, { maxConcurrent: 1 })
    await createReadyTask(store, { title: 'A', priority: 'high' })
    await createReadyTask(store, { title: 'B', priority: 'low' })

    const first = await dispatcher.claimNext('worker-1', T0)
    expect(first?.title).toBe('A')

    const second = await dispatcher.claimNext('worker-1', T0)
    expect(second).toBeUndefined()
  })

  it('holds a task until its blocking dependency is done', async () => {
    const store = createStore()
    const dispatcher = createDispatcher(store)
    const dep = await store.create({ title: 'Dependency', now: T0 })
    await createReadyTask(store, {
      title: 'Blocked',
      dependencies: [{ taskId: dep.id, kind: 'blocks' }],
    })

    expect(await dispatcher.readyTasks(T0)).toEqual([])

    // Finish the dependency: inbox → triaged → ready → running → done.
    await store.transition(dep.id, {
      to: 'triaged',
      expectedVersion: 1,
      at: T0,
    })
    await store.transition(dep.id, { to: 'ready', expectedVersion: 2, at: T0 })
    await store.transition(dep.id, {
      to: 'running',
      expectedVersion: 3,
      at: T0,
    })
    await store.transition(dep.id, { to: 'done', expectedVersion: 4, at: T0 })

    const ready = await dispatcher.readyTasks(T0)
    expect(ready.map((task) => task.title)).toEqual(['Blocked'])
  })

  it('recovers the board across a restart', async () => {
    const registry = createRegistry()
    const chronicle = new MemoryChronicleStore(registry)
    const store1 = new ChronicleKanbanStore(chronicle)
    const task = await createReadyTask(store1)
    await createDispatcher(store1).claimNext('worker-1', T0)

    // "Restart": a fresh projection over the same durable log.
    const store2 = new ChronicleKanbanStore(chronicle)
    await store2.rebuild()
    const recovered = await store2.get(task.id)
    expect(recovered?.status).toBe('running')
    expect(recovered?.claim?.claimant).toBe('worker-1')

    // The new dispatcher reclaims the now-expired lease.
    const reclaimed = await createDispatcher(store2).reclaimExpired(T2)
    expect(reclaimed).toEqual([task.id])
  })
})
