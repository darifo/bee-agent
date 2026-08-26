import { describe, expect, it, vi } from 'vitest'
import { AllowlistedNetworkSandbox } from '../src/network-sandbox.ts'
import type { ActionRequest } from '../src/execution-world.ts'

function request(target: string): ActionRequest {
  return {
    id: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    capability: 'tool:remote_agent__reviewer',
    subject: { type: 'agent', id: 'bee' },
    input: { item: { kind: 'request', text: 'review' } },
    requirements: {
      readPaths: [],
      writePaths: [],
      networkTargets: [target],
      commands: [],
      secretEnv: {},
    },
    expectedEffects: [],
    verification: [],
    scope: { threadId: 'thread', turnId: 'turn' },
  }
}

describe('AllowlistedNetworkSandbox', () => {
  it('passes only the pinned origin to the transport', async () => {
    const transport = vi.fn(async () => ({
      output: { trajectoryId: 'trajectory-1' },
      content: 'reviewed',
      verification: [],
    }))
    const sandbox = new AllowlistedNetworkSandbox(
      ['https://remote.example/v1/agent'],
      { request: transport },
    )
    await expect(
      sandbox.execute(request('https://remote.example'), {
        secrets: new Map(),
      }),
    ).resolves.toMatchObject({ content: 'reviewed' })
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'https://remote.example' }),
    )
  })

  it('rejects undeclared targets and mixed local effects', async () => {
    const sandbox = new AllowlistedNetworkSandbox(['https://remote.example'], {
      request: vi.fn(),
    })
    await expect(
      sandbox.execute(request('https://evil.example'), { secrets: new Map() }),
    ).rejects.toThrow('not allowlisted')
    const mixed = request('https://remote.example')
    mixed.requirements.commands.push(['/bin/echo'])
    await expect(
      sandbox.execute(mixed, { secrets: new Map() }),
    ).rejects.toThrow('does not accept')
  })
})
