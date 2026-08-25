import { describe, expect, it } from 'vitest'
import { LlmRuntimeError } from '@bee-agent/runtime'
import type { ContextBundle, LlmStreamEvent } from '@bee-agent/runtime'
import { ModelProtocolError } from '../src/index.ts'
import { OpenAIChatRuntime } from '../src/index.ts'

interface Call {
  readonly url: string
  readonly init: RequestInit
  readonly body: Record<string, unknown>
}

function fakeFetch(responses: unknown[], onCall?: (call: Call) => void) {
  const calls: Call[] = []
  let index = 0
  const fetchImpl: typeof fetch = async (url, init) => {
    if (init?.signal?.aborted) {
      throw new DOMException('This operation was aborted', 'AbortError')
    }
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

function chatCompletion(
  message: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): unknown {
  return {
    choices: [{ index: 0, message, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
    },
    ...extra,
  }
}

function bundle(overrides: Partial<ContextBundle> = {}): ContextBundle {
  return {
    messages: [
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'compute 12*7' },
    ],
    tools: [
      {
        id: 'tools.calculator',
        description: 'Evaluates arithmetic expressions',
        inputSchema: { type: 'object' },
      },
    ],
    ...overrides,
  }
}

async function collect(
  events: AsyncIterable<LlmStreamEvent>,
): Promise<LlmStreamEvent[]> {
  const collected: LlmStreamEvent[] = []
  for await (const event of events) {
    collected.push(event)
  }
  return collected
}

describe('OpenAIChatRuntime', () => {
  it('streams model text and reports usage', async () => {
    const { fetchImpl, calls } = fakeFetch([
      chatCompletion({ role: 'assistant', content: 'the answer is 84' }),
    ])
    const runtime = new OpenAIChatRuntime({
      apiKey: 'sk-test',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com',
      fetch: fetchImpl,
    })

    const call = runtime.generate(bundle())
    const events = await collect(call.events)
    const result = await call.result

    expect(events).toEqual([
      { kind: 'message-delta', delta: 'the answer is 84' },
    ])
    expect(result.stopReason).toBe('end_turn')
    expect(result.usage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
    })
    expect(result.provider.id).toBe('api.deepseek.com')

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://api.deepseek.com/chat/completions')
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-test')
    expect(calls[0]?.body.model).toBe('deepseek-chat')
    expect(calls[0]?.body.messages).toEqual([
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'compute 12*7' },
    ])
    const tools = calls[0]?.body.tools as { function: { name: string } }[]
    expect(tools?.[0]?.function.name).toBe('tools_calculator')
  })

  it('streams tool intents without executing them', async () => {
    const { fetchImpl } = fakeFetch([
      {
        choices: [
          {
            index: 0,
            message: {
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
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      },
    ])
    const runtime = new OpenAIChatRuntime({
      apiKey: 'sk-test',
      model: 'deepseek-chat',
      fetch: fetchImpl,
    })

    const call = runtime.generate(bundle())
    const events = await collect(call.events)
    const result = await call.result

    expect(events).toEqual([
      {
        kind: 'tool-intent',
        call: {
          callId: 'call-1',
          toolId: 'tools.calculator',
          input: { expression: '12*7' },
        },
      },
    ])
    expect(result.stopReason).toBe('tool_calls')
  })

  it('passes tool results back as assistant/tool messages', async () => {
    const { fetchImpl, calls } = fakeFetch([
      chatCompletion({ role: 'assistant', content: '84' }),
    ])
    const runtime = new OpenAIChatRuntime({
      apiKey: 'sk-test',
      model: 'deepseek-chat',
      fetch: fetchImpl,
    })
    const input = bundle({
      messages: [
        { role: 'user', content: 'compute' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              callId: 'call-1',
              toolId: 'tools.calculator',
              input: { expression: '12*7' },
            },
          ],
        },
        {
          role: 'tool',
          callId: 'call-1',
          toolId: 'tools.calculator',
          content: '84',
        },
      ],
    })

    await runtime.generate(input).result
    expect(calls[0]?.body.messages).toEqual([
      { role: 'user', content: 'compute' },
      {
        role: 'assistant',
        content: '',
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
        content: '84',
      },
    ])
  })

  it('parses structured decisions when a decision schema is present', async () => {
    const { fetchImpl, calls } = fakeFetch([
      chatCompletion({
        role: 'assistant',
        content: '{"action":"respond","text":"hi"}',
      }),
    ])
    const runtime = new OpenAIChatRuntime({
      apiKey: 'sk-test',
      model: 'deepseek-chat',
      fetch: fetchImpl,
    })

    const call = runtime.generate(
      bundle({ decisionSchema: { type: 'object' } }),
    )
    const events = await collect(call.events)
    const result = await call.result

    expect(events).toEqual([
      { kind: 'message-delta', delta: '{"action":"respond","text":"hi"}' },
      {
        kind: 'decision',
        decision: { action: 'respond', text: 'hi' },
      },
    ])
    expect(result.stopReason).toBe('decision')
    // The runtime asked the provider for a JSON object.
    expect(calls[0]?.body.response_format).toEqual({ type: 'json_object' })
  })

  it('reports capabilities from options', () => {
    const runtime = new OpenAIChatRuntime({
      apiKey: 'sk-test',
      model: 'm',
      maxContextTokens: 64000,
      maxOutputTokens: 4096,
    })
    expect(runtime.capabilities()).toEqual({
      streaming: false,
      tools: true,
      structuredDecisions: true,
      maxContextTokens: 64000,
      maxOutputTokens: 4096,
    })
  })
})

describe('OpenAIChatRuntime error classification', () => {
  it('classifies 401 as fatal', async () => {
    const { fetchImpl } = fakeFetch([
      { status: 401, error: { message: 'Invalid API key' } },
    ])
    const runtime = new OpenAIChatRuntime({
      apiKey: 'sk-bad',
      model: 'deepseek-chat',
      fetch: fetchImpl,
    })
    const error = await runtime
      .generate(bundle())
      .result.catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(LlmRuntimeError)
    if (error instanceof LlmRuntimeError) {
      expect(error.retryability).toBe('fatal')
      expect(error.message).toMatch(/Invalid API key/)
    }
  })

  it('classifies 429 as retryable', async () => {
    const { fetchImpl } = fakeFetch([
      { status: 429, error: { message: 'rate limited' } },
    ])
    const runtime = new OpenAIChatRuntime({
      apiKey: 'sk-test',
      model: 'm',
      fetch: fetchImpl,
    })
    const error = await runtime
      .generate(bundle())
      .result.catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(LlmRuntimeError)
    if (error instanceof LlmRuntimeError) {
      expect(error.retryability).toBe('retryable')
    }
  })

  it('classifies context-length failures as context-overflow', async () => {
    const { fetchImpl } = fakeFetch([
      { status: 400, error: { message: 'context_length_exceeded' } },
    ])
    const runtime = new OpenAIChatRuntime({
      apiKey: 'sk-test',
      model: 'm',
      fetch: fetchImpl,
    })
    const error = await runtime
      .generate(bundle())
      .result.catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(LlmRuntimeError)
    if (error instanceof LlmRuntimeError) {
      expect(error.retryability).toBe('context-overflow')
    }
  })

  it('rejects responses without choices', async () => {
    const { fetchImpl } = fakeFetch([{ object: 'list' }])
    const runtime = new OpenAIChatRuntime({
      apiKey: 'sk-test',
      model: 'm',
      fetch: fetchImpl,
    })
    await expect(runtime.generate(bundle()).result).rejects.toThrow(
      ModelProtocolError,
    )
  })
})

describe('OpenAIChatRuntime cancellation', () => {
  it('settles cancelled when the signal is aborted', async () => {
    const { fetchImpl } = fakeFetch([])
    const runtime = new OpenAIChatRuntime({
      apiKey: 'sk-test',
      model: 'm',
      fetch: fetchImpl,
    })
    const controller = new AbortController()
    controller.abort()

    const call = runtime.generate(bundle(), { signal: controller.signal })
    await expect(collect(call.events)).resolves.toEqual([])
    const result = await call.result
    expect(result.stopReason).toBe('cancelled')
  })
})
