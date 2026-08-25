import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@bee-agent/contracts'
import { describeEvent } from '../src/format.ts'

function event(type: string, payload: Record<string, unknown>): AgentEvent {
  return {
    id: `event-${type}`,
    taskId: '4e5d6c58-6c66-4c99-bd51-6b2b6c0b7cc1',
    sequence: 1,
    type,
    payload,
    createdAt: '2026-08-23T00:00:00.000Z',
  }
}

describe('describeEvent', () => {
  it('renders messages, tools, and approvals readably', () => {
    expect(
      describeEvent(
        event('agent.message', { role: 'assistant', content: 'hi' }),
      ),
    ).toBe('assistant: hi')
    expect(
      describeEvent(
        event('tool.call', {
          call: {
            toolId: 'tools.calculator',
            arguments: { expression: '1+1' },
          },
        }),
      ),
    ).toContain('tools.calculator')
    expect(
      describeEvent(
        event('tool.result', {
          result: { callId: 'c1', output: undefined, error: 'denied' },
        }),
      ),
    ).toBe('tool error: denied')
    expect(
      describeEvent(
        event('approval.requested', {
          request: { risk: 'high', reason: 'risky' },
        }),
      ),
    ).toBe('approval requested (high): risky')
    expect(
      describeEvent(event('task.failed', { state: 'failed', error: 'boom' })),
    ).toBe('task failed: boom')
    expect(describeEvent(event('custom.thing', {}))).toBe('custom.thing')
  })
})
