import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentEvent } from '@bee-agent/contracts'
import { MockAgent, TaskCancelledError, ToolRegistry } from '@bee-agent/runtime'
import type { AgentRunContext } from '@bee-agent/runtime'
import { buildServer } from '@bee-agent/server'
import type { BeeServer } from '@bee-agent/server'
import {
  CommandAgent,
  CommandAgentConfigSchema,
  CommandAgentError,
  RemoteAgent,
} from '../src/index.js'

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
): { context: AgentRunContext; messages: { role: string; content: string }[] } {
  const messages: { role: string; content: string }[] = []
  const context: AgentRunContext = {
    taskId: randomUUID(),
    input,
    metadata: {},
    workspaceId: undefined,
    tools: new ToolRegistry(),
    cancelled: false,
    throwIfCancelled: () => {},
    emit: async () => {},
    emitMessage: async (role, content) => {
      messages.push({ role, content })
    },
    callTool: async () => {
      throw new Error('not expected in these tests')
    },
    ...overrides,
  }
  return { context, messages }
}

describe('RemoteAgent', () => {
  it('delegates to a remote server and mirrors its messages', async () => {
    const agent = new RemoteAgent({ id: 'agent.remote', baseUrl: remoteUrl })
    const { context, messages } = runContext('delegate me')

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
    const { context } = runContext('cancel me', {
      throwIfCancelled: () => {
        if (cancelled) throw new TaskCancelledError('local', undefined)
      },
    })

    const promise = agent.run(context)
    cancelled = true
    await expect(promise).rejects.toBeInstanceOf(TaskCancelledError)
  })
})

describe('CommandAgent', () => {
  it('wraps argv-driven programs with {input} placeholders', async () => {
    const echo = new CommandAgent({
      id: 'agent.argv',
      command: '/bin/echo',
      args: ['heard:', '{input}'],
    })
    const { context } = runContext('hello adapter')
    const result = await echo.run(context)
    expect(result.output).toBe('heard: hello adapter\n')
  })

  it('feeds stdin when inputVia is stdin', async () => {
    const agent = new CommandAgent({
      id: 'agent.stdin',
      command: process.execPath,
      args: [
        '-e',
        'process.stdin.resume(); let d=""; process.stdin.on("data", c => d += c); process.stdin.on("end", () => process.stdout.write(d.toUpperCase()))',
      ],
      inputVia: 'stdin',
    })
    const { context } = runContext('shout this')
    const result = await agent.run(context)
    expect(result.output).toBe('SHOUT THIS')
  })

  it('maps non-zero exits and timeouts to errors', async () => {
    const failing = new CommandAgent({
      id: 'agent.fail',
      command: process.execPath,
      args: ['-e', 'process.stderr.write("boom\\n"); process.exit(3)'],
    })
    await expect(failing.run(runContext('x').context)).rejects.toThrow(
      /exited with code 3.*boom/,
    )

    const slow = new CommandAgent({
      id: 'agent.slow',
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 30000)'],
      timeoutMs: 300,
    })
    await expect(slow.run(runContext('x').context)).rejects.toThrow(
      CommandAgentError,
    )
  })

  it('validates configs by schema', () => {
    expect(() =>
      CommandAgentConfigSchema.parse({ id: '', command: 'node' }),
    ).toThrow()
    expect(
      CommandAgentConfigSchema.parse({ id: 'a', command: 'node' }),
    ).toMatchObject({ args: [], inputVia: 'args' })
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
