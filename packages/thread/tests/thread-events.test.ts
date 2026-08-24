import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ChronicleSchemaRegistry } from '@bee-agent/knowledge'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'
import { newChronicleEvent } from '@bee-agent/knowledge'
import {
  UnknownThreadEventTypeError,
  appendThreadEvents,
  itemCompletedEvent,
  itemDeltaEvent,
  itemStartedEvent,
  newItem,
  newThread,
  newTurn,
  readThreadEvents,
  registerThreadChronicleEvents,
  threadCreatedEvent,
  threadStreamId,
  turnCompletedEvent,
  turnStartedEvent,
} from '../src/index.js'
import type { ChronicleStore, ThreadEvent } from '../src/index.js'

function createStore(): ChronicleStore {
  const registry = new ChronicleSchemaRegistry()
  registerThreadChronicleEvents(registry)
  return new MemoryChronicleStore(registry)
}

const NOW = '2026-08-24T10:00:00.000Z'
const STRUCTURE_DIGEST =
  'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

describe('thread events over Chronicle', () => {
  it('appends a full turn lifecycle with contiguous sequences', async () => {
    const store = createStore()
    const thread = newThread({ title: 'Notes', now: NOW })
    const turn = newTurn({
      threadId: thread.id,
      trigger: 'user',
      input: 'Summarize',
      structureVersion: STRUCTURE_DIGEST,
      now: NOW,
    })
    const item = newItem({
      threadId: thread.id,
      turnId: turn.id,
      type: 'message',
      payload: { role: 'assistant', content: '' },
      now: NOW,
    })

    const stored = await appendThreadEvents(store, thread.id, [
      threadCreatedEvent(thread, { actor: { type: 'user', id: 'local' } }),
      turnStartedEvent(turn),
      itemStartedEvent(item),
      itemDeltaEvent(
        { threadId: thread.id, turnId: turn.id, itemId: item.id },
        'Summarizing…',
      ),
      itemDeltaEvent(
        { threadId: thread.id, turnId: turn.id, itemId: item.id },
        ' done.',
      ),
      itemCompletedEvent({
        ...item,
        status: 'completed',
        payload: { role: 'assistant', content: 'Summarizing… done.' },
      }),
      turnCompletedEvent({ ...turn, status: 'completed', endedAt: NOW }),
    ])

    expect(stored.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(stored[0]?.actor).toEqual({ type: 'user', id: 'local' })
    expect(stored[0]?.threadId).toBe(thread.id)
    expect(stored[0]?.turnId).toBeUndefined()
    expect(stored[1]?.turnId).toBe(turn.id)
    // The turn pins the structure it runs under on the envelope.
    expect(stored[1]?.structureVersion).toBe(STRUCTURE_DIGEST)
    expect(await store.getLatestSequence(threadStreamId(thread.id))).toBe(7)
  })

  it('recovers wire events with after semantics and no gaps', async () => {
    const { store, threadId } = await seedOneTurn()

    const all = await readThreadEvents(store, threadId)
    expect(all.hasMore).toBe(false)
    expect(all.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5])
    expect(all.events.map((event) => event.event)).toEqual([
      'thread.created',
      'turn.started',
      'item.started',
      'item.delta',
      'item.completed',
    ])

    // A reconnecting client resumes after its last seen sequence.
    const tail = await readThreadEvents(store, threadId, { after: 3 })
    expect(tail.events.map((event) => event.sequence)).toEqual([4, 5])
    expect(tail.events[0]?.event).toBe('item.delta')

    const nothing = await readThreadEvents(store, threadId, { after: 5 })
    expect(nothing.events).toEqual([])
    expect(nothing.hasMore).toBe(false)
  })

  it('pages with a limit and signals hasMore', async () => {
    const { store, threadId } = await seedOneTurn()

    const first = await readThreadEvents(store, threadId, { limit: 2 })
    expect(first.events.map((event) => event.sequence)).toEqual([1, 2])
    expect(first.hasMore).toBe(true)

    const second = await readThreadEvents(store, threadId, {
      after: first.events[1]?.sequence,
      limit: 2,
    })
    expect(second.events.map((event) => event.sequence)).toEqual([3, 4])
    expect(second.hasMore).toBe(true)

    const third = await readThreadEvents(store, threadId, {
      after: second.events[1]?.sequence,
      limit: 2,
    })
    expect(third.events.map((event) => event.sequence)).toEqual([5])
    expect(third.hasMore).toBe(false)
  })

  it('maps stored payloads back into typed wire events', async () => {
    const { store, threadId } = await seedOneTurn()
    const page = await readThreadEvents(store, threadId)

    const started = page.events.find(
      (event): event is Extract<ThreadEvent, { event: 'item.started' }> =>
        event.event === 'item.started',
    )
    expect(started?.item.type).toBe('message')
    expect(started?.item.payload).toEqual({
      role: 'assistant',
      content: 'hello',
    })
    const turnStarted = page.events.find(
      (event): event is Extract<ThreadEvent, { event: 'turn.started' }> =>
        event.event === 'turn.started',
    )
    expect(turnStarted?.turn.trigger).toBe('user')
    expect(turnStarted?.turn.input).toBe('hi')
  })

  it('fails loud on foreign events in a thread stream', async () => {
    const registry = new ChronicleSchemaRegistry()
    registerThreadChronicleEvents(registry)
    // An unrelated but registry-valid event type that does not belong in a
    // thread stream.
    registry.register('test.foreign', { payload: z.object({}) })
    const store = new MemoryChronicleStore(registry)

    const thread = newThread({ title: 'Mixed', now: NOW })
    await appendThreadEvents(store, thread.id, [threadCreatedEvent(thread)])
    const foreign = newChronicleEvent({
      eventType: 'test.foreign',
      actor: { type: 'system', id: 'test' },
      payload: {},
    })
    await store.append(threadStreamId(thread.id), [foreign], {
      expectedSequence: 2,
    })

    await expect(readThreadEvents(store, thread.id)).rejects.toThrow(
      UnknownThreadEventTypeError,
    )
  })

  it('surfaces concurrent-writer conflicts instead of overwriting', async () => {
    const store = createStore()
    const thread = newThread({ title: 'Race', now: NOW })
    await appendThreadEvents(store, thread.id, [threadCreatedEvent(thread)])
    const turn = newTurn({ threadId: thread.id, trigger: 'user', now: NOW })
    const writerA = appendThreadEvents(store, thread.id, [
      turnStartedEvent(turn),
    ])
    const writerB = appendThreadEvents(store, thread.id, [
      turnStartedEvent(turn),
    ])
    await expect(writerA).resolves.toHaveLength(1)
    await expect(writerB).rejects.toThrow(
      /expected next sequence 2 but the next free sequence is 3/,
    )
  })
})

async function seedOneTurn(): Promise<{
  store: ChronicleStore
  threadId: string
}> {
  const store = createStore()
  const thread = newThread({ title: 'Chat', now: NOW })
  const turn = newTurn({
    threadId: thread.id,
    trigger: 'user',
    input: 'hi',
    now: NOW,
  })
  const item = newItem({
    threadId: thread.id,
    turnId: turn.id,
    type: 'message',
    payload: { role: 'assistant', content: 'hello' },
    now: NOW,
  })
  await appendThreadEvents(store, thread.id, [
    threadCreatedEvent(thread),
    turnStartedEvent(turn),
    itemStartedEvent(item),
    itemDeltaEvent(
      { threadId: thread.id, turnId: turn.id, itemId: item.id },
      'hello',
    ),
    itemCompletedEvent(item),
  ])
  return { store, threadId: thread.id }
}
