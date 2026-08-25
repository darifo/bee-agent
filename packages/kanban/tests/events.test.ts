import { describe, expect, it } from 'vitest'
import {
  ChronicleSchemaRegistry,
  ChronicleSequenceConflictError,
  newChronicleEvent,
} from '@bee-agent/knowledge'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'
import {
  appendKanbanTaskEvents,
  applyTransition,
  kanbanStreamId,
  kanbanTaskCreatedEvent,
  kanbanTaskIdFromStream,
  kanbanTaskStatusChangedEvent,
  newKanbanTask,
  registerKanbanChronicleEvents,
} from '../src/index.ts'
import type { KanbanTask, KanbanTaskStatus } from '../src/index.ts'

const NOW = '2026-08-25T10:00:00.000Z'
const LATER = '2026-08-25T11:00:00.000Z'

function createStore(): MemoryChronicleStore {
  const registry = new ChronicleSchemaRegistry()
  registerKanbanChronicleEvents(registry)
  return new MemoryChronicleStore(registry)
}

/** Walks a task through `path` (each entry a status), building its events. */
function walk(
  task: KanbanTask,
  path: readonly KanbanTaskStatus[],
): {
  task: KanbanTask
  events: ReturnType<typeof kanbanTaskCreatedEvent>[]
} {
  const events = [kanbanTaskCreatedEvent(task)]
  let current = task
  for (const to of path) {
    const from = current.status
    current = applyTransition(current, {
      to,
      expectedVersion: current.version,
      at: LATER,
    })
    events.push(kanbanTaskStatusChangedEvent({ from, task: current }))
  }
  return { task: current, events }
}

describe('kanban task events over Chronicle', () => {
  it('appends a created event scoped to the task stream', async () => {
    const store = createStore()
    const task = newKanbanTask({ title: 'Write the notes', now: NOW })

    const stored = await appendKanbanTaskEvents(store, task.id, [
      kanbanTaskCreatedEvent(task),
    ])

    expect(stored).toHaveLength(1)
    expect(stored[0]?.streamId).toBe(kanbanStreamId(task.id))
    expect(stored[0]?.sequence).toBe(1)
    expect(stored[0]?.eventType).toBe('kanban.task.created')
    expect(stored[0]?.taskId).toBe(task.id)
    expect(stored[0]?.actor).toEqual({ type: 'agent', id: 'bee' })
    expect(stored[0]?.payload).toEqual({ task })
    expect(await store.getLatestSequence(kanbanStreamId(task.id))).toBe(1)
  })

  it('records a status change with from/to/version and the resulting task', async () => {
    const store = createStore()
    const task = newKanbanTask({ title: 'Triage me', now: NOW })
    await appendKanbanTaskEvents(store, task.id, [kanbanTaskCreatedEvent(task)])

    const triaged = applyTransition(task, {
      to: 'triaged',
      expectedVersion: 1,
      at: LATER,
    })
    const stored = await appendKanbanTaskEvents(store, task.id, [
      kanbanTaskStatusChangedEvent({ from: 'inbox', task: triaged }),
    ])

    expect(stored[0]?.sequence).toBe(2)
    expect(stored[0]?.eventType).toBe('kanban.task.status_changed')
    expect(stored[0]?.payload).toEqual({
      from: 'inbox',
      to: 'triaged',
      task: triaged,
    })
    expect(triaged.version).toBe(2)
  })

  it('walks the full happy path as contiguous, versioned events', async () => {
    const store = createStore()
    const task = newKanbanTask({ title: 'Ship it', now: NOW })
    const { task: done, events } = walk(task, [
      'triaged',
      'ready',
      'running',
      'review',
      'done',
    ])

    const stored = await appendKanbanTaskEvents(store, task.id, events)

    expect(stored.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6])
    expect(stored.map((event) => event.eventType)).toEqual([
      'kanban.task.created',
      'kanban.task.status_changed',
      'kanban.task.status_changed',
      'kanban.task.status_changed',
      'kanban.task.status_changed',
      'kanban.task.status_changed',
    ])
    expect(done.status).toBe('done')
    expect(done.version).toBe(6)
    expect(done.endedAt).toBe(LATER)
  })

  it('surfaces concurrent-writer sequence conflicts', async () => {
    const store = createStore()
    const task = newKanbanTask({ title: 'Race', now: NOW })
    await appendKanbanTaskEvents(store, task.id, [kanbanTaskCreatedEvent(task)])

    const triaged = applyTransition(task, {
      to: 'triaged',
      expectedVersion: 1,
      at: LATER,
    })
    // Two writers build their own event (distinct event ids) for the same
    // transition — a genuine race, not an idempotent retry of one event.
    const changeA = kanbanTaskStatusChangedEvent({
      from: 'inbox',
      task: triaged,
    })
    const changeB = kanbanTaskStatusChangedEvent({
      from: 'inbox',
      task: triaged,
    })

    const writerA = store.append(kanbanStreamId(task.id), [changeA], {
      expectedSequence: 2,
    })
    const writerB = store.append(kanbanStreamId(task.id), [changeB], {
      expectedSequence: 2,
    })
    await expect(writerA).resolves.toHaveLength(1)
    await expect(writerB).rejects.toBeInstanceOf(ChronicleSequenceConflictError)
  })

  it('rejects unregistered event types and invalid payloads', async () => {
    const registry = new ChronicleSchemaRegistry()
    const store = new MemoryChronicleStore(registry)
    const task = newKanbanTask({ title: 'Unregistered', now: NOW })

    await expect(
      appendKanbanTaskEvents(store, task.id, [kanbanTaskCreatedEvent(task)]),
    ).rejects.toThrow(/Unknown Chronicle event type/)

    registerKanbanChronicleEvents(registry)
    await expect(
      store.append(
        kanbanStreamId(task.id),
        [
          newChronicleEvent({
            eventType: 'kanban.task.created',
            actor: { type: 'system', id: 'test' },
            payload: { task: { id: 'not-a-uuid' } },
          }),
        ],
        { expectedSequence: 1 },
      ),
    ).rejects.toThrow(/payload schema/)
  })

  it('round-trips task ids through their stream id', () => {
    const task = newKanbanTask({ title: 'Round trip', now: NOW })
    expect(kanbanTaskIdFromStream(kanbanStreamId(task.id))).toBe(task.id)
    expect(() => kanbanTaskIdFromStream('thread:123')).toThrow(/not a kanban/)
  })
})
