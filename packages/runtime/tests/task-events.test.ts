import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { AgentEvent, TaskSpec, ToolCall } from '@bee-agent/contracts'
import {
  applyTaskEvent,
  initialTaskSnapshot,
  reduceTaskSnapshot,
} from '../src/index.js'

const taskId = randomUUID()

function specFixture(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: taskId,
    input: 'compute',
    agentId: 'agent.mock',
    metadata: {},
    ...overrides,
  }
}

function event(
  sequence: number,
  type: string,
  payload: Record<string, unknown>,
): AgentEvent {
  return {
    id: randomUUID(),
    taskId,
    sequence,
    type,
    payload,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, sequence)).toISOString(),
  }
}

describe('task event reducer', () => {
  it('starts from an empty pending snapshot', () => {
    const snapshot = initialTaskSnapshot(taskId)
    expect(snapshot.state).toBe('pending')
    expect(snapshot.lastSequence).toBe(0)
    expect(snapshot.spec).toBeUndefined()
    expect(snapshot.messages).toEqual([])
  })

  it('folds a happy-path stream', async () => {
    const snapshot = await reduceTaskSnapshot(taskId, [
      event(1, 'task.created', { spec: specFixture(), state: 'pending' }),
      event(2, 'task.started', { state: 'running' }),
      event(3, 'agent.message', { role: 'assistant', content: 'working' }),
      event(4, 'task.completed', {
        state: 'completed',
        result: { done: true },
      }),
    ])
    expect(snapshot.state).toBe('completed')
    expect(snapshot.spec).toEqual(specFixture())
    expect(snapshot.result).toEqual({ done: true })
    expect(snapshot.messages).toEqual([
      { role: 'assistant', content: 'working' },
    ])
    expect(snapshot.lastSequence).toBe(4)
    expect(snapshot.createdAt).toBeDefined()
    expect(snapshot.updatedAt).toBeDefined()
  })

  it('tracks pending approvals across suspension and resume', async () => {
    const approval = {
      id: randomUUID(),
      taskId,
      toolCall: {
        id: randomUUID(),
        taskId,
        toolId: 'tools.echo',
        arguments: { value: 'hi' },
      } satisfies ToolCall,
      reason: 'risky',
      risk: 'high',
      createdAt: new Date().toISOString(),
    }
    let snapshot = await reduceTaskSnapshot(taskId, [
      event(1, 'task.created', { spec: specFixture(), state: 'pending' }),
      event(2, 'task.started', { state: 'running' }),
      event(3, 'approval.requested', { request: approval }),
      event(4, 'task.suspended', {
        state: 'waiting_approval',
        approvalId: approval.id,
      }),
    ])
    expect(snapshot.state).toBe('waiting_approval')
    expect(snapshot.pendingApprovalId).toBe(approval.id)
    expect(snapshot.approvals).toHaveLength(1)

    snapshot = applyTaskEvent(
      snapshot,
      event(5, 'approval.decided', {
        decision: {
          requestId: approval.id,
          approved: true,
          decidedAt: new Date().toISOString(),
        },
      }),
    )
    snapshot = applyTaskEvent(
      snapshot,
      event(6, 'task.resumed', {
        state: 'running',
        approvalId: approval.id,
        approved: true,
      }),
    )
    expect(snapshot.state).toBe('running')
    expect(snapshot.pendingApprovalId).toBeUndefined()
    expect(snapshot.decisions).toHaveLength(1)
  })

  it('records tool calls and results', async () => {
    const call = {
      id: randomUUID(),
      taskId,
      toolId: 'tools.echo',
      arguments: { value: 21 },
    } satisfies ToolCall
    const snapshot = await reduceTaskSnapshot(taskId, [
      event(1, 'task.created', { spec: specFixture(), state: 'pending' }),
      event(2, 'task.started', { state: 'running' }),
      event(3, 'tool.call', { call }),
      event(4, 'tool.result', {
        result: { callId: call.id, output: 42, error: undefined },
      }),
    ])
    expect(snapshot.toolCalls).toEqual([call])
    expect(snapshot.toolResults).toEqual([
      { callId: call.id, output: 42, error: undefined },
    ])
  })

  it('requires task.created to be the first event', async () => {
    await expect(
      reduceTaskSnapshot(taskId, [
        event(1, 'task.started', { state: 'running' }),
        event(2, 'task.created', { spec: specFixture(), state: 'pending' }),
      ]),
    ).rejects.toThrow('task.created must be the first event of a task')
  })

  it('rejects illegal transitions during replay', async () => {
    await expect(
      reduceTaskSnapshot(taskId, [
        event(1, 'task.created', { spec: specFixture(), state: 'pending' }),
        event(2, 'task.completed', { state: 'completed', result: null }),
      ]),
    ).rejects.toThrow("Invalid task state transition 'pending' -> 'completed'")
  })

  it('rejects sequence gaps and foreign events', async () => {
    const base = initialTaskSnapshot(taskId)
    expect(() =>
      applyTaskEvent(base, event(2, 'task.started', { state: 'running' })),
    ).toThrow('Expected event sequence 1')
    expect(() =>
      applyTaskEvent(base, {
        ...event(1, 'task.started', { state: 'running' }),
        taskId: randomUUID(),
      }),
    ).toThrow('does not belong to task')
  })

  it('ignores unknown event types but advances the sequence', async () => {
    const snapshot = await reduceTaskSnapshot(taskId, [
      event(1, 'task.created', { spec: specFixture(), state: 'pending' }),
      event(2, 'custom.future-event', { anything: true }),
    ])
    expect(snapshot.state).toBe('pending')
    expect(snapshot.lastSequence).toBe(2)
    expect(snapshot.updatedAt).toBeDefined()
  })
})
