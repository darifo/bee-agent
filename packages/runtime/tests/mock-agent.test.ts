import { describe, expect, it } from 'vitest'
import { MockAgent, ToolRegistry } from '../src/index.js'
import type { AgentRunContext, Tool } from '../src/index.js'
import type { ToolResult } from '@bee-agent/contracts'

const echoTool: Tool = {
  manifest: {
    id: 'tools.echo',
    name: 'Echo',
    description: 'returns its input',
    inputSchema: {},
  },
  execute: (input) => input,
}

function stubContext(
  overrides: Partial<AgentRunContext> = {},
): AgentRunContext {
  const tools = new ToolRegistry().register(echoTool)
  const emitted: Array<{ type: string; payload: Record<string, unknown> }> = []
  const toolResults: ToolResult[] = []
  return {
    taskId: '4e5d6c58-6c66-4c99-bd51-6b2b6c0b7cc1',
    input: 'hello',
    metadata: {},
    workspaceId: undefined,
    tools,
    cancelled: false,
    throwIfCancelled: () => {},
    emit: async (type, payload) => {
      emitted.push({ type, payload })
    },
    emitMessage: async (role, content) => {
      emitted.push({ type: 'agent.message', payload: { role, content } })
    },
    callTool: async (toolId, input) => {
      const result: ToolResult = {
        callId: crypto.randomUUID(),
        output: tools.require(toolId).execute(input, {
          taskId: '4e5d6c58-6c66-4c99-bd51-6b2b6c0b7cc1',
          callId: 'stub',
        }),
      }
      toolResults.push(result)
      return result
    },
    ...overrides,
  }
}

describe('mock agent', () => {
  it('echoes the input with an empty script', async () => {
    const agent = new MockAgent()
    const context = stubContext()
    const result = await agent.run(context)
    expect(result.output).toEqual({
      replies: ['Received: hello'],
      toolResults: [],
    })
  })

  it('uses a custom id', () => {
    expect(new MockAgent({ id: 'agent.custom' }).id).toBe('agent.custom')
    expect(new MockAgent().id).toBe('agent.mock')
  })

  it('executes say and tool steps in order', async () => {
    const agent = new MockAgent({
      script: [
        { kind: 'say', content: 'thinking' },
        { kind: 'tool', toolId: 'tools.echo', input: { value: 1 } },
        { kind: 'say', content: 'done' },
      ],
    })
    const context = stubContext()
    const result = await agent.run(context)
    const output = result.output as { replies: string[] }
    expect(output.replies).toEqual(['thinking', 'done'])
  })

  it('fails the run on a fail step', async () => {
    const agent = new MockAgent({
      script: [
        { kind: 'say', content: 'about to fail' },
        { kind: 'fail', message: 'boom' },
      ],
    })
    await expect(agent.run(stubContext())).rejects.toThrow('boom')
  })

  it('stops before the next step once cancelled', async () => {
    const agent = new MockAgent({
      script: [
        { kind: 'say', content: 'first' },
        { kind: 'say', content: 'second' },
      ],
    })
    let cancelled = false
    const context = stubContext({
      get cancelled() {
        return cancelled
      },
      throwIfCancelled: () => {
        if (cancelled) throw new Error('cancelled!')
      },
    })
    const first = agent.run(context).then(
      () => 'completed',
      (error: unknown) => (error as Error).message,
    )
    cancelled = true
    await expect(first).resolves.toBe('cancelled!')
  })
})
