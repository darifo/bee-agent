import { describe, expect, it } from 'vitest'
import {
  ITEM_TYPES,
  ItemDeltaEventSchema,
  ItemSchema,
  ThreadEventPageSchema,
  ThreadEventSchema,
  ThreadSchema,
  TurnSchema,
} from '../src/protocol.js'
import type { Item } from '../src/protocol.js'

/**
 * Protocol contract tests. This file imports ONLY `../src/protocol.js` —
 * the same module clients consume via `@bee-agent/thread/protocol` — so the
 * suite itself proves the protocol surface needs nothing but zod.
 */

const threadId = '0b6c6a68-8c5f-4d8f-9b52-1f2b1a2c3d4e'
const turnId = '1c7d7b79-9d6f-5e9f-ac63-2f3c2b3d4e5f'
const itemId = '2d8e8c8a-ae70-4f0a-bd74-3a4d3c4e5f6a'

function itemFixture(overrides: Record<string, unknown> = {}): Item {
  return ItemSchema.parse({
    id: itemId,
    threadId,
    turnId,
    status: 'active',
    createdAt: '2026-08-24T10:00:00.000Z',
    type: 'message',
    payload: { role: 'assistant', content: 'Working on it' },
    ...overrides,
  })
}

describe('Thread and Turn contracts', () => {
  it('round-trips a thread with optional workspace and memory view', () => {
    const thread = ThreadSchema.parse({
      id: threadId,
      title: 'Personal assistant',
      createdAt: '2026-08-24T10:00:00.000Z',
      updatedAt: '2026-08-24T10:00:00.000Z',
    })
    expect(thread.workspaceId).toBeUndefined()

    const full = ThreadSchema.parse({
      ...thread,
      workspaceId: 'ws-1',
      memoryView: { id: 'personal', version: '2' },
    })
    expect(full.memoryView).toEqual({ id: 'personal', version: '2' })
    expect(() => ThreadSchema.parse({ ...thread, title: '' })).toThrow()
  })

  it('round-trips a turn and pins its optional structure version', () => {
    const turn = TurnSchema.parse({
      id: turnId,
      threadId,
      status: 'active',
      trigger: 'user',
      input: 'Summarize my notes',
      structureVersion:
        'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      startedAt: '2026-08-24T10:00:00.000Z',
    })
    expect(turn.trigger).toBe('user')
    expect(() => TurnSchema.parse({ ...turn, status: 'paused' })).toThrow()
  })
})

describe('Item contract', () => {
  it('supports every item type from the architecture set', () => {
    const fixtures: Record<string, unknown> = {
      message: { role: 'user', content: 'hi' },
      plan: { planId: 'plan-1', version: '1' },
      tool_call: { toolId: 'calculator', callId: 'call-1', input: { a: 1 } },
      approval: { title: 'Run migrations', status: 'pending' },
      artifact: {
        digest:
          'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        size: 42,
      },
      file_change: { path: 'src/a.ts', change: 'modified' },
      memory_citation: { memoryId: 'mem-1', snippet: 'prefers dark mode' },
      learning_note: { text: 'User prefers concise answers' },
    }
    expect(Object.keys(fixtures).sort()).toEqual([...ITEM_TYPES].sort())
    for (const [type, payload] of Object.entries(fixtures)) {
      const item = itemFixture({ type, payload })
      expect(item.type).toBe(type)
    }
  })

  it('rejects a payload that does not match the item type', () => {
    expect(() =>
      itemFixture({ type: 'artifact', payload: { role: 'user' } }),
    ).toThrow()
    expect(() =>
      itemFixture({
        type: 'artifact',
        payload: { digest: 'not-a-digest', size: 1 },
      }),
    ).toThrow()
    expect(() => itemFixture({ type: 'mystery', payload: {} })).toThrow()
  })

  it('models item terminal states', () => {
    const completed = itemFixture({
      status: 'completed',
      endedAt: '2026-08-24T10:00:05.000Z',
    })
    expect(completed.status).toBe('completed')
    const failed = itemFixture({
      status: 'failed',
      error: 'tool crashed',
    })
    expect(failed.error).toBe('tool crashed')
  })
})

describe('Lifecycle event contract', () => {
  const sequence = 7

  it('parses an item.delta event', () => {
    const event = ItemDeltaEventSchema.parse({
      sequence,
      threadId,
      turnId,
      event: 'item.delta',
      itemId,
      delta: ' working',
    })
    expect(event.delta).toBe(' working')
  })

  it('parses every event kind through the union and rejects unknown kinds', () => {
    const base = { sequence, threadId, turnId }
    const item = itemFixture()
    const events = [
      {
        ...base,
        event: 'turn.started',
        turn: {
          id: turnId,
          threadId,
          status: 'active',
          trigger: 'user',
          startedAt: '2026-08-24T10:00:00.000Z',
        },
      },
      {
        ...base,
        event: 'turn.completed',
        turn: {
          id: turnId,
          threadId,
          status: 'completed',
          trigger: 'user',
          startedAt: '2026-08-24T10:00:00.000Z',
          endedAt: '2026-08-24T10:00:09.000Z',
        },
      },
      {
        ...base,
        event: 'turn.failed',
        error: 'model unavailable',
        turn: {
          id: turnId,
          threadId,
          status: 'failed',
          trigger: 'user',
          startedAt: '2026-08-24T10:00:00.000Z',
        },
      },
      { ...base, event: 'item.started', item },
      { ...base, event: 'item.delta', itemId, delta: '…' },
      {
        ...base,
        event: 'item.completed',
        item: { ...item, status: 'completed' },
      },
      { ...base, event: 'item.failed', itemId, error: 'boom' },
    ]
    for (const event of events) {
      expect(ThreadEventSchema.parse(event).event).toBe(event.event)
    }
    expect(() =>
      ThreadEventSchema.parse({ ...base, event: 'item.cancelled' }),
    ).toThrow()
  })

  it('parses thread.created without a turn scope', () => {
    const event = ThreadEventSchema.parse({
      sequence: 1,
      threadId,
      event: 'thread.created',
      thread: {
        id: threadId,
        title: 'New thread',
        createdAt: '2026-08-24T10:00:00.000Z',
        updatedAt: '2026-08-24T10:00:00.000Z',
      },
    })
    expect(event.event).toBe('thread.created')
    expect('turnId' in event && event.turnId).toBeFalsy()
  })

  it('parses a page of events with a hasMore flag', () => {
    const page = ThreadEventPageSchema.parse({
      events: [
        {
          sequence: 1,
          threadId,
          turnId,
          event: 'item.delta',
          itemId,
          delta: 'a',
        },
      ],
      hasMore: true,
    })
    expect(page.hasMore).toBe(true)
    expect(page.events).toHaveLength(1)
  })
})
