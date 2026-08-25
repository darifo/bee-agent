import { describe, expect, it } from 'vitest'
import type { ThreadEvent } from '@bee-agent/thread'
import { deriveEntries } from '../src/messages.ts'

const threadId = '0b6c6a68-8c5f-4d8f-9b52-1f2b1a2c3d4e'
const turnId = '1c7d7b79-9d6f-5e9f-ac63-2f3c2b3d4e5f'
const itemId = '2d8e8c8a-ae70-4f0a-bd74-3a4d3c4e5f6a'

function messageItem(role: string, content: string): Record<string, unknown> {
  return {
    id: itemId,
    threadId,
    turnId,
    status: 'completed',
    createdAt: '2026-08-25T10:00:00.000Z',
    type: 'message',
    payload: { role, content },
  }
}

describe('deriveEntries', () => {
  it('reduces user and assistant messages into entries', () => {
    const events: ThreadEvent[] = [
      {
        sequence: 1,
        threadId,
        turnId,
        event: 'item.completed',
        item: messageItem('user', 'hi') as never,
      },
      {
        sequence: 2,
        threadId,
        turnId,
        event: 'item.completed',
        item: messageItem('assistant', 'hello there') as never,
      },
    ]
    expect(deriveEntries(events)).toEqual([
      { kind: 'user', content: 'hi' },
      { kind: 'assistant', content: 'hello there' },
    ])
  })

  it('accumulates assistant deltas and finalizes on completion', () => {
    const events: ThreadEvent[] = [
      {
        sequence: 1,
        threadId,
        turnId,
        event: 'item.started',
        item: messageItem('assistant', '') as never,
      },
      {
        sequence: 2,
        threadId,
        turnId,
        event: 'item.delta',
        itemId,
        delta: 'Hel',
      },
      {
        sequence: 3,
        threadId,
        turnId,
        event: 'item.delta',
        itemId,
        delta: 'lo',
      },
    ]
    expect(deriveEntries(events)).toEqual([
      { kind: 'assistant', content: 'Hello' },
    ])
  })

  it('maps tool calls and approvals', () => {
    const events: ThreadEvent[] = [
      {
        sequence: 1,
        threadId,
        turnId,
        event: 'item.completed',
        item: {
          id: itemId,
          threadId,
          turnId,
          status: 'completed',
          createdAt: '2026-08-25T10:00:00.000Z',
          type: 'tool_call',
          payload: { toolId: 'calculator', callId: 'c1', input: {}, output: 3 },
        } as never,
      },
      {
        sequence: 2,
        threadId,
        turnId,
        event: 'item.completed',
        item: {
          id: itemId,
          threadId,
          turnId,
          status: 'completed',
          createdAt: '2026-08-25T10:00:00.000Z',
          type: 'approval',
          payload: { title: 'Deploy?', status: 'approved' },
        } as never,
      },
    ]
    expect(deriveEntries(events)).toEqual([
      { kind: 'tool', toolId: 'calculator' },
      { kind: 'approval', title: 'Deploy?', status: 'approved' },
    ])
  })
})
