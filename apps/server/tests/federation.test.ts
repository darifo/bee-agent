import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RemoteAgent } from '@bee-agent/agent-adapters'
import type { AgentEvent } from '@bee-agent/contracts'
import { MockAgent, TaskCancelledError, ToolRegistry } from '@bee-agent/runtime'
import type { AgentRunContext } from '@bee-agent/runtime'
import { buildServer } from '../src/index.js'
import type { BeeServer } from '../src/index.js'

// These tests live on the server (not in adapters/agents) so the workspace
// keeps a strict adapters -> apps dependency direction; the reverse devDep
// made `pnpm -r build` race inside the cycle.

let remote: BeeServer
let remoteUrl: string

beforeAll(async () => {
  remote = await buildServer({
    sqliteFilename: ':memory:',
    logger: false,
    defaultAgent: new MockAgent({
      script: [
        { kind: 'say', content: 'remote says hello' },
        { kind: 'say', content: 'remote says goodbye' },
      ],
    }),
  })
  await remote.app.listen({ host: '127.0.0.1', port: 0 })
  remoteUrl = `http://127.0.0.1:${(remote.app.server.address() as AddressInfo).port}`
})

afterAll(async () => {
  remote.app.server.closeAllConnections()
  await remote.app.close()
})

function runContext(
  input: string,
  overrides: Partial<AgentRunContext> = {},
): AgentRunContext {
  return {
    taskId: randomUUID(),
    input,
    metadata: {},
    workspaceId: undefined,
    tools: new ToolRegistry(),
    cancelled: false,
    throwIfCancelled: () => {},
    emit: async () => {},
    emitMessage: async () => {},
    callTool: async () => {
      throw new Error('not expected in these tests')
    },
    ...overrides,
  }
}

describe('RemoteAgent', () => {
  it('delegates to a remote server and mirrors its messages', async () => {
    const agent = new RemoteAgent({ id: 'agent.remote', baseUrl: remoteUrl })
    const messages: { role: string; content: string }[] = []
    const context = runContext('delegate me', {
      emitMessage: async (role, content) => {
        messages.push({ role, content })
      },
    })

    const result = await agent.run(context)
    expect(messages).toEqual([
      { role: 'assistant', content: 'remote says hello' },
      { role: 'assistant', content: 'remote says goodbye' },
    ])
    expect(result.output).toEqual({
      replies: ['remote says hello', 'remote says goodbye'],
      toolResults: [],
    })
  })

  it('propagates cancellation to the remote task', async () => {
    const agent = new RemoteAgent({ id: 'agent.remote', baseUrl: remoteUrl })
    let cancelled = false
    const context = runContext('cancel me', {
      throwIfCancelled: () => {
        if (cancelled) throw new TaskCancelledError('local', undefined)
      },
    })

    const promise = agent.run(context)
    cancelled = true
    await expect(promise).rejects.toBeInstanceOf(TaskCancelledError)
  })
})

describe('server federation end to end', () => {
  it('runs a local task through a remote agent registered on the server', async () => {
    const local = await buildServer({
      sqliteFilename: ':memory:',
      logger: false,
      agents: [new RemoteAgent({ id: 'agent.remote', baseUrl: remoteUrl })],
    })
    try {
      const spec = await local.runtime.createTask({
        input: 'federate me',
        agentId: 'agent.remote',
        metadata: {},
      })
      await local.runtime.run(spec.id)
      const events: AgentEvent[] = []
      for await (const event of local.runtime.readEvents(spec.id)) {
        events.push(event)
      }
      const messages = events.filter((event) => event.type === 'agent.message')
      expect(
        messages.map((event) => (event.payload as { content: string }).content),
      ).toEqual(['remote says hello', 'remote says goodbye'])
      const snapshot = await local.runtime.getSnapshot(spec.id)
      expect(snapshot.state).toBe('completed')
    } finally {
      await local.app.close()
    }
  })
})
