import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import type {
  BeeAgentClient,
  ModelReplayDto,
  TrajectoryPageDto,
  TrajectoryQuery,
} from '@bee-agent/client'
import { App } from '../src/App.tsx'

afterEach(cleanup)

const ENTRIES: TrajectoryPageDto['entries'] = [
  {
    eventId: 'e1',
    streamId: 'thread:abc',
    sequence: 3,
    eventTime: '2026-09-01T02:03:04.000Z',
    eventType: 'turn.started',
    loop: 'fast',
    category: 'input',
    summary: '你好 Bee',
    detail: { turn: { input: '你好 Bee' } },
  },
  {
    eventId: 'e2',
    streamId: 'model-request:req-1',
    sequence: 1,
    eventTime: '2026-09-01T02:03:05.000Z',
    eventType: 'model.requested',
    loop: 'fast',
    category: 'llm',
    summary: 'fake-model · step 0 · attempt 0',
    detail: { requestId: 'req-1', model: 'fake-model' },
  },
  {
    eventId: 'e3',
    streamId: 'memory',
    sequence: 1,
    eventTime: '2026-09-01T02:03:06.000Z',
    eventType: 'memory.claim.recorded',
    loop: 'slow',
    category: 'memory',
    summary: 'preference: 用中文写周报',
    detail: { claim: { statement: '用中文写周报' } },
  },
]

const REPLAY: ModelReplayDto = {
  requestId: 'req-1',
  manifest: {
    id: '11111111-1111-4111-8111-111111111111',
    promptVersion: 'bee@1',
    structureVersion: 'sha256:abc',
    tokenBudget: 8192,
    sections: [
      {
        kind: 'memory',
        sourceIds: ['memory:0'],
        rendererVersion: 'bee-memory-text@1',
        priority: 1,
        tokens: 24,
        digest:
          'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      },
    ],
    omissions: [],
  },
  bundle: {
    messages: [{ role: 'user', content: '你好 Bee' }],
  },
}

function fakeClient(): BeeAgentClient {
  return {
    listTrajectory: vi.fn(async (query: TrajectoryQuery = {}) => {
      const entries = ENTRIES.filter(
        (entry) =>
          (query.loop === undefined || entry.loop === query.loop) &&
          (query.category === undefined || entry.category === query.category),
      )
      return {
        entries,
        counts: {
          fast: 2,
          slow: 1,
          byCategory: {
            input: 1,
            llm: 1,
            tool: 0,
            memory: 1,
            reasoning: 0,
            proposal: 0,
            system: 0,
          },
        },
        scannedStreams: 3,
      } satisfies TrajectoryPageDto
    }),
    replayModelRequest: vi.fn(async () => REPLAY),
  } as unknown as BeeAgentClient
}

/**
 * The trajectory tab (architecture §7.4): the fast/slow loop switch refetches
 * with the loop filter, chips filter by category, and a model call expands to
 * its digest-verified replay — including the recalled-memory section.
 */
describe('trajectory view', () => {
  it('switches between fast and slow loops and filters by category', async () => {
    const client = fakeClient()
    render(<App client={client} />)

    fireEvent.click(screen.getByRole('button', { name: '轨迹' }))
    await waitFor(() => {
      expect(screen.getByText(/你好 Bee/)).toBeDefined()
    })
    expect(client.listTrajectory).toHaveBeenLastCalledWith({
      loop: 'fast',
      limit: 150,
    })

    fireEvent.click(screen.getByRole('tab', { name: /后台慢循环/ }))
    await waitFor(() => {
      expect(screen.getByText(/用中文写周报/)).toBeDefined()
    })
    expect(client.listTrajectory).toHaveBeenLastCalledWith({
      loop: 'slow',
      limit: 150,
    })

    fireEvent.click(screen.getByRole('button', { name: /^🧠 记忆/ }))
    await waitFor(() => {
      expect(client.listTrajectory).toHaveBeenLastCalledWith({
        loop: 'slow',
        category: 'memory',
        limit: 150,
      })
    })
  })

  it('expands an entry to its durable position and replays the model input', async () => {
    const client = fakeClient()
    render(<App client={client} />)

    fireEvent.click(screen.getByRole('button', { name: '轨迹' }))
    await waitFor(() => {
      expect(screen.getByText(/fake-model · step 0/)).toBeDefined()
    })

    fireEvent.click(screen.getByRole('button', { name: /fake-model · step 0/ }))
    await waitFor(() => {
      expect(screen.getByText(/model-request:req-1/)).toBeDefined()
    })

    fireEvent.click(screen.getByRole('button', { name: /重放模型输入/ }))
    await waitFor(() => {
      expect(client.replayModelRequest).toHaveBeenCalledWith('req-1')
    })
    await waitFor(() => {
      expect(screen.getByText(/记忆召回/)).toBeDefined()
      expect(screen.getAllByText(/你好 Bee/).length).toBeGreaterThan(1)
    })
  })
})
