import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ToolResult } from '@bee-agent/contracts'
import { ToolRegistry } from '@bee-agent/runtime'
import { TaskCancelledError } from '@bee-agent/runtime'
import type { AgentRunContext } from '@bee-agent/runtime'
import {
  ModelProtocolError,
  ModelProviderError,
  OpenAIChatAgent,
} from '../src/index.js'

interface Call {
  readonly url: string
  readonly init: RequestInit
  readonly body: Record<string, unknown>
}

function fakeFetch(responses: unknown[], onCall?: (call: Call) => void) {
  const calls: Call[] = []
  let index = 0
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<
      string,
      unknown
    >
    const call: Call = { url: url.toString(), init: init ?? {}, body }
    calls.push(call)
    onCall?.(call)
    const payload = responses[index]
    index += 1
    const response = payload as { status?: number } | undefined
    const status =
      response !== null && typeof response === 'object' && 'status' in response
        ? ((response as { status: number }).status ?? 200)
        : 200
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetchImpl, calls }
}

function chatCompletion(message: Record<string, unknown>): unknown {
  return { choices: [{ index: 0, message, finish_reason: 'stop' }] }
}

function createContext(overrides: Partial<AgentRunContext> = {}): {
  context: AgentRunContext
  messages: { role: string; content: string }[]
  toolCalls: { toolId: string; input: Record<string, unknown> }[]
  results: ToolResult[]
} {
  const messages: { role: string; content: string }[] = []
  const toolCalls: { toolId: string; input: Record<string, unknown> }[] = []
  const results: ToolResult[] = []
  const registry = new ToolRegistry()
  registry.register({
    manifest: {
      id: 'tools.calculator',
      name: 'Calculator',
      description: 'Evaluates arithmetic expressions',
      inputSchema: {
        type: 'object',
        properties: { expression: { type: 'string' } },
      },
    },
    execute: async (input) => String(input.expression ?? ''),
  })
  const context: AgentRunContext = {
    taskId: randomUUID(),
    input: 'compute 12*7',
    metadata: {},
    workspaceId: undefined,
    tools: registry,
    cancelled: false,
    throwIfCancelled: () => {
      if (context.cancelled) {
        throw new TaskCancelledError(context.taskId, undefined)
      }
    },
    emit: async () => {},
    emitMessage: async (role, content) => {
      messages.push({ role, content })
    },
    callTool: async (toolId, input) => {
      toolCalls.push({ toolId, input })
      const result: ToolResult = {
        callId: randomUUID(),
        output: `echo:${JSON.stringify(input)}`,
      }
      results.push(result)
      return result
    },
    ...overrides,
  }
  return { context, messages, toolCalls, results }
}

describe('OpenAIChatAgent', () => {
  it('sends an authorized chat completion and returns model text', async () => {
    const { fetchImpl, calls } = fakeFetch([
      chatCompletion({ role: 'assistant', content: 'the answer is 84' }),
    ])
    const agent = new OpenAIChatAgent({
      apiKey: 'sk-test',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com',
      systemPrompt: 'be terse',
      fetch: fetchImpl,
    })
    const { context, messages } = createContext()

    const result = await agent.run(context)
    expect(result.output).toEqual({
      replies: ['the answer is 84'],
      toolResults: [],
    })
    expect(messages).toEqual([
      { role: 'assistant', content: 'the answer is 84' },
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://api.deepseek.com/chat/completions')
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-test')
    expect(calls[0]?.body.model).toBe('deepseek-chat')
    expect(calls[0]?.body.messages).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'compute 12*7' },
    ])
    // Registered tools are offered as functions with sanitized names.
    const tools = calls[0]?.body.tools as {
      function: { name: string }
    }[]
    expect(tools?.[0]?.function.name).toBe('tools_calculator')
  })

  it('runs the tool-call loop and feeds results back', async () => {
    const { fetchImpl, calls } = fakeFetch([
      chatCompletion({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: {
              name: 'tools_calculator',
              arguments: '{"expression":"12*7"}',
            },
          },
        ],
      }),
      chatCompletion({ role: 'assistant', content: '12*7 = 84' }),
    ])
    const agent = new OpenAIChatAgent({
      apiKey: 'sk-test',
      model: 'deepseek-chat',
      fetch: fetchImpl,
    })
    const { context, toolCalls, results } = createContext()

    const result = await agent.run(context)
    // The sanitized function name maps back to the real tool id.
    expect(toolCalls).toEqual([
      { toolId: 'tools.calculator', input: { expression: '12*7' } },
    ])
    expect(result.output).toEqual({
      replies: ['12*7 = 84'],
      toolResults: results,
    })

    // The second request carries the assistant tool_call plus the tool message.
    const second = calls[1]?.body.messages as Record<string, unknown>[]
    expect(second).toEqual([
      { role: 'user', content: 'compute 12*7' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: {
              name: 'tools_calculator',
              arguments: '{"expression":"12*7"}',
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call-1',
        content: JSON.stringify('echo:{"expression":"12*7"}'),
      },
    ])
  })

  it('maps tool errors into error payloads', async () => {
    const { fetchImpl } = fakeFetch([
      chatCompletion({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'tools_calculator', arguments: 'not-json' },
          },
        ],
      }),
      chatCompletion({ role: 'assistant', content: 'recovered' }),
    ])
    const agent = new OpenAIChatAgent({
      apiKey: 'sk-test',
      model: 'deepseek-chat',
      fetch: fetchImpl,
    })
    const { context } = createContext({
      callTool: async () => ({
        callId: randomUUID(),
        error: 'division by zero',
      }),
    })

    const result = await agent.run(context)
    expect(result.output).toEqual({
      replies: ['recovered'],
      toolResults: [{ callId: expect.any(String), error: 'division by zero' }],
    })
  })

  it('surfaces provider failures with status and body', async () => {
    const { fetchImpl } = fakeFetch([
      { status: 401, error: { message: 'Invalid API key' } },
    ])
    const agent = new OpenAIChatAgent({
      apiKey: 'sk-bad',
      model: 'deepseek-chat',
      fetch: fetchImpl,
    })
    const error = (await agent
      .run(createContext().context)
      .catch((reason: unknown) => reason)) as ModelProviderError
    expect(error).toBeInstanceOf(ModelProviderError)
    expect(error.status).toBe(401)
    expect(error.message).toMatch(/Invalid API key/)
  })

  it('rejects responses without choices', async () => {
    const { fetchImpl } = fakeFetch([{ object: 'list' }])
    const agent = new OpenAIChatAgent({
      apiKey: 'sk-test',
      model: 'deepseek-chat',
      fetch: fetchImpl,
    })
    await expect(agent.run(createContext().context)).rejects.toThrow(
      ModelProtocolError,
    )
  })

  it('bounds the tool-call loop', async () => {
    const endless = Array.from({ length: 5 }, () =>
      chatCompletion({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: `call-${randomUUID()}`,
            type: 'function',
            function: { name: 'tools_calculator', arguments: '{}' },
          },
        ],
      }),
    )
    const { fetchImpl } = fakeFetch(endless)
    const agent = new OpenAIChatAgent({
      apiKey: 'sk-test',
      model: 'deepseek-chat',
      maxTurns: 3,
      fetch: fetchImpl,
    })
    await expect(agent.run(createContext().context)).rejects.toThrow(
      /kept requesting tools after 3 turns/,
    )
  })

  it('honours cancellation between turns', async () => {
    const { fetchImpl } = fakeFetch([
      chatCompletion({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'tools_calculator', arguments: '{}' },
          },
        ],
      }),
      chatCompletion({ role: 'assistant', content: 'second' }),
    ])
    const agent = new OpenAIChatAgent({
      apiKey: 'sk-test',
      model: 'deepseek-chat',
      fetch: fetchImpl,
    })
    let cancelled = false
    const { context } = createContext({
      get cancelled() {
        return cancelled
      },
      throwIfCancelled: () => {
        if (cancelled) throw new TaskCancelledError('task', undefined)
      },
    })

    const promise = agent.run(context)
    cancelled = true
    await expect(promise).rejects.toBeInstanceOf(TaskCancelledError)
  })
})
