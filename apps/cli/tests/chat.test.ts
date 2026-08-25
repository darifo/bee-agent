import { describe, expect, it } from 'vitest'
import type { BeeAgentClient, TurnResult } from '@bee-agent/client'
import type { Turn } from '@bee-agent/thread'
import { runTurnToCompletion } from '../src/chat.ts'

const threadId = '0b6c6a68-8c5f-4d8f-9b52-1f2b1a2c3d4e'
const turnId = '1c7d7b79-9d6f-5e9f-ac63-2f3c2b3d4e5f'

function turn(status: Turn['status']): Turn {
  return {
    id: turnId,
    threadId,
    status,
    trigger: 'user',
    startedAt: '2026-08-25T10:00:00.000Z',
  }
}

interface FakeApiState {
  readonly results: TurnResult[]
  readonly resolved: Array<{
    turnId: string
    approvalId: string
    decision: 'approved' | 'rejected'
  }>
}

function fakeApi(state: FakeApiState): BeeAgentClient {
  const resultQueue = [...state.results]
  const resolved = state.resolved
  return {
    async createTurn(): Promise<TurnResult> {
      const next = resultQueue.shift()
      if (next === undefined) throw new Error('no scripted result')
      return next
    },
    async resolveApproval(
      _threadId: string,
      tId: string,
      approvalId: string,
      decision: 'approved' | 'rejected',
    ): Promise<TurnResult> {
      resolved.push({ turnId: tId, approvalId, decision })
      const next = resultQueue.shift()
      if (next === undefined)
        throw new Error('no scripted result after approval')
      return next
    },
  } as unknown as BeeAgentClient
}

describe('runTurnToCompletion', () => {
  it('returns a completed turn without deciding an approval', async () => {
    const resolved: FakeApiState['resolved'] = []
    const api = fakeApi({
      results: [
        { status: 'completed', output: 'done', turn: turn('completed') },
      ],
      resolved,
    })
    const decide = async (): Promise<'approved' | 'rejected'> => {
      throw new Error('should not be called')
    }

    const result = await runTurnToCompletion(api, threadId, 'hi', decide)
    expect(result.status).toBe('completed')
    expect(resolved).toEqual([])
  })

  it('resolves an approval and continues to completion', async () => {
    const resolved: FakeApiState['resolved'] = []
    const api = fakeApi({
      results: [
        {
          status: 'suspended',
          approval: { approvalId: 'approval-1', title: 'Deploy?' },
          turn: turn('active'),
        },
        { status: 'completed', output: 'deployed', turn: turn('completed') },
      ],
      resolved,
    })
    const decisions: string[] = []
    const decide = async (approval: {
      title: string
    }): Promise<'approved' | 'rejected'> => {
      decisions.push(approval.title)
      return 'approved'
    }

    const result = await runTurnToCompletion(api, threadId, 'deploy', decide)
    expect(result.status).toBe('completed')
    expect(decisions).toEqual(['Deploy?'])
    expect(resolved).toEqual([
      { turnId, approvalId: 'approval-1', decision: 'approved' },
    ])
  })

  it('keeps resolving until the turn reaches a terminal state', async () => {
    const resolved: FakeApiState['resolved'] = []
    const api = fakeApi({
      results: [
        {
          status: 'suspended',
          approval: { approvalId: 'a1', title: 'First' },
          turn: turn('active'),
        },
        {
          status: 'suspended',
          approval: { approvalId: 'a2', title: 'Second' },
          turn: turn('active'),
        },
        { status: 'failed', error: 'stopped', turn: turn('failed') },
      ],
      resolved,
    })
    const decide = async (): Promise<'approved' | 'rejected'> => 'rejected'

    const result = await runTurnToCompletion(api, threadId, 'go', decide)
    expect(result.status).toBe('failed')
    expect(resolved).toHaveLength(2)
    expect(resolved[0]?.decision).toBe('rejected')
    expect(resolved[1]?.decision).toBe('rejected')
  })
})
