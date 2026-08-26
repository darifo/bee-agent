import { describe, expect, it, vi } from 'vitest'
import {
  DelegationLimitError,
  DelegationSupervisor,
} from '../src/delegation-supervisor.ts'
import { RemoteAgentAdapter } from '../src/remote-agent.ts'

describe('bounded delegation', () => {
  const limits = {
    maxDepth: 1,
    maxConcurrency: 2,
    maxChildren: 3,
    maxTokens: 100,
    maxDurationMs: 2_000,
    maxCostUsd: 1,
    maxWorldActions: 3,
  }

  it('preserves parent-child lineage under bounded concurrency', async () => {
    let active = 0
    let peak = 0
    const supervisor = new DelegationSupervisor({
      limits,
      execute: async (request) => {
        active += 1
        peak = Math.max(peak, active)
        await Promise.resolve()
        active -= 1
        return {
          id: request.id,
          parentEpisodeId: request.parentEpisodeId,
          childEpisodeId: `child:${request.id}`,
          trajectoryId: `trajectory:${request.id}`,
          output: request.input,
          usage: { tokens: 10, costUsd: 0.01, worldActions: 1 },
        }
      },
    })
    const result = await supervisor.run(
      [1, 2, 3].map((input) => ({
        id: String(input),
        parentEpisodeId: 'parent',
        depth: 1,
        input,
      })),
    )
    expect(peak).toBeLessThanOrEqual(2)
    expect(result.map((item) => item.parentEpisodeId)).toEqual([
      'parent',
      'parent',
      'parent',
    ])
    expect(result.map((item) => item.trajectoryId)).toEqual([
      'trajectory:1',
      'trajectory:2',
      'trajectory:3',
    ])
  })

  it('cancels the episode when a cumulative budget is exceeded', async () => {
    const supervisor = new DelegationSupervisor({
      limits,
      execute: vi.fn(async (request) => ({
        id: request.id,
        parentEpisodeId: request.parentEpisodeId,
        childEpisodeId: `child:${request.id}`,
        trajectoryId: `trajectory:${request.id}`,
        output: request.input,
        usage: { tokens: 101, costUsd: 0, worldActions: 0 },
      })),
    })
    await expect(
      supervisor.run([
        { id: '1', parentEpisodeId: 'parent', depth: 1, input: 'work' },
      ]),
    ).rejects.toEqual(expect.objectContaining({ limit: 'maxTokens' }))
  })

  it('rejects depth before starting a child', async () => {
    const supervisor = new DelegationSupervisor({
      limits,
      execute: vi.fn(),
    })
    await expect(
      supervisor.run([
        { id: '1', parentEpisodeId: 'parent', depth: 2, input: 'work' },
      ]),
    ).rejects.toBeInstanceOf(DelegationLimitError)
  })
})

describe('RemoteAgentAdapter', () => {
  it('pins HTTPS origin and never performs transport itself', async () => {
    const adapter = new RemoteAgentAdapter({
      id: 'reviewer',
      endpoint: 'https://agents.example/v2/run',
      description: 'Review a bounded change',
      inputSchema: { type: 'object' },
      secretEnv: { TOKEN: 'keychain:bee/remote-agent' },
    })
    const call = {
      callId: 'call-1',
      toolId: 'remote_agent__reviewer',
      input: { task: 'review' },
    }
    expect(adapter.describe(call)).toMatchObject({
      capability: 'tool:remote_agent__reviewer',
      requirements: {
        networkTargets: ['https://agents.example'],
        secretEnv: { TOKEN: 'keychain:bee/remote-agent' },
      },
    })
    await expect(adapter.execute()).rejects.toThrow('network sandbox')
  })

  it('rejects plaintext HTTP manifests', () => {
    expect(
      () =>
        new RemoteAgentAdapter({
          id: 'unsafe',
          endpoint: 'http://agents.example/run',
          description: 'unsafe',
          inputSchema: {},
        }),
    ).toThrow('HTTPS')
  })
})
