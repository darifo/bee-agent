import { describe, expect, it } from 'vitest'
import { AgentEventSchema, TaskSpecSchema } from '../src/index.ts'

describe('contracts', () => {
  it('applies task metadata defaults', () => {
    const task = TaskSpecSchema.parse({
      id: '5d99ff39-08bb-4191-ad48-e76a392ae489',
      input: 'calculate 1 + 1',
      agentId: 'mock-agent',
    })
    expect(task.metadata).toEqual({})
  })

  it('rejects non-positive event sequences', () => {
    expect(() =>
      AgentEventSchema.parse({
        id: 'bfa55c92-572d-4e84-8c05-f9c542c17b83',
        taskId: '5d99ff39-08bb-4191-ad48-e76a392ae489',
        sequence: 0,
        type: 'task.created',
        payload: {},
        createdAt: new Date().toISOString(),
      }),
    ).toThrow()
  })
})
