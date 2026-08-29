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

/** A scripted response: JSON payload, or SSE chunks, or an error status. */
type ScriptedResponse =
  | { readonly kind: 'json'; readonly payload: unknown }
  | { readonly kind: 'sse'; readonly chunks: unknown[] }
  | {
      readonly kind: 'error'
      readonly status: number
      readonly payload: unknown
      readonly headers?: Record<string, string>
    }

function fakeFetch(
  responses: ScriptedResponse[],
  onCall?: (call: Call) => void,
) {
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
    const scriptedResponse = responses[index]
    index += 1
    if (scriptedResponse === undefined) {
      throw new Error('fakeFetch ran out of scripted responses')
    }
    if (scriptedResponse.kind === 'sse') {
      const text =
        scriptedResponse.chunks
          .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
          .join('') + 'data: [DONE]\n\n'
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(text))
            controller.close()
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        },
      )
    }
    if (scriptedResponse.kind === 'error') {
      return new Response(JSON.stringify(scriptedResponse.payload), {
        status: scriptedResponse.status,
        headers: {
          'content-type': 'application/json',
          ...(scriptedResponse.headers ?? {}),
        },
      })
    }
    return new Response(JSON.stringify(scriptedResponse.payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetchImpl, calls }
}

function json(payload: unknown): ScriptedResponse {
  return { kind: 'json', payload }
}

function sse(...chunks: unknown[]): ScriptedResponse {
  return { kind: 'sse', chunks }
}

/** One streaming text chunk, in OpenAI wire shape. */
function textDelta(content: string): unknown {
  return { choices: [{ index: 0, delta: { content } }] }
}

/** One streaming tool-call fragment, in OpenAI wire shape. */
function toolDelta(
  index: number,
  fragment: {
    id?: string
    name?: string
    arguments?: string
  },
): unknown {
  return {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index,
              ...(fragment.id === undefined ? {} : { id: fragment.id }),
              type: 'function',
              function: {
                ...(fragment.name === undefined ? {} : { name: fragment.name }),
                ...(fragment.arguments === undefined
                  ? {}
                  : { arguments: fragment.arguments }),
              },
            },
          ],
        },
      },
    ],
  }
}

function finish(reason: string): unknown {
  return { choices: [{ index: 0, delta: {}, finish_reason: reason }] }
}

function usageChunk(usage: {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}): unknown {
  return { choices: [], usage }
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
  it('streams model text chunk by chunk and reports usage', async () => {
    const { fetchImpl, calls } = fakeFetch([
      sse(
        textDelta('the answer '),
        textDelta('is 84'),
        finish('stop'),
        usageChunk({
          prompt_tokens: 11,
          completion_tokens: 7,
          total_tokens: 18,
        }),
      ),
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
      { kind: 'message-delta', delta: 'the answer ' },
      { kind: 'message-delta', delta: 'is 84' },
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
    expect(calls[0]?.body.stream).toBe(true)
    expect(calls[0]?.body.stream_options).toEqual({ include_usage: true })
    expect(calls[0]?.body.messages).toEqual([
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'compute 12*7' },
    ])
    const tools = calls[0]?.body.tools as { function: { name: string } }[]
    expect(tools?.[0]?.function.name).toBe('tools_calculator')
  })

  it('assembles tool intents from streamed argument fragments', async () => {
    const { fetchImpl } = fakeFetch([
      sse(
        toolDelta(0, {
          id: 'call-1',
          name: 'tools_calculator',
          arguments: '{"expr',
        }),
        toolDelta(0, { arguments: 'ession":"12*7"}' }),
        finish('tool_calls'),
        usageChunk({
          prompt_tokens: 11,
          completion_tokens: 7,
          total_tokens: 18,
        }),
      ),
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

  it('marks malformed streamed arguments as inputError instead of executing', async () => {
    const { fetchImpl } = fakeFetch([
      sse(
        toolDelta(0, {
          id: 'call-9',
          name: 'tools_calculator',
          arguments: '{"oops',
        }),
        finish('tool_calls'),
      ),
    ])
    const runtime = new OpenAIChatRuntime({
      apiKey: 'sk-test',
      model: 'deepseek-chat',
      fetch: fetchImpl,
    })

    const events = await collect(runtime.generate(bundle()).events)
    expect(events).toEqual([
      {
        kind: 'tool-intent',
        call: {
          callId: 'call-9',
          toolId: 'tools.calculator',
          input: {},
          inputError: expect.stringContaining('not valid JSON'),
        },
      },
    ])
  })

  it('falls back to buffered JSON when the response is not event-stream', async () => {
    const { fetchImpl, calls } = fakeFetch([
      json(chatCompletion({ role: 'assistant', content: 'the answer is 84' })),
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
      { kind: 'message-delta', delta: 'the answer is 84' },
    ])
    expect(result.stopReason).toBe('end_turn')
    expect(result.usage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
    })
    // Streaming was requested but the provider answered with JSON.
    expect(calls[0]?.body.stream).toBe(true)
  })

  it('does not request streaming when the option is off', async () => {
    const { fetchImpl, calls } = fakeFetch([
      json(chatCompletion({ role: 'assistant', content: 'plain' })),
    ])
    const runtime = new OpenAIChatRuntime({
      apiKey: 'sk-test',
      model: 'm',
      fetch: fetchImpl,
      streaming: false,
    })

    await runtime.generate(bundle()).result
    expect(calls[0]?.body.stream).toBeUndefined()
    expect(runtime.capabilities().streaming).toBe(false)
  })

  it('passes tool results back as assistant/tool messages', async () => {
    const { fetchImpl, calls } = fakeFetch([
      json(chatCompletion({ role: 'assistant', content: '84' })),
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
      sse(
        textDelta('{"action":"respond",'),
        textDelta('"text":"hi"}'),
        finish('stop'),
      ),
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
      { kind: 'message-delta', delta: '{"action":"respond",' },
      { kind: 'message-delta', delta: '"text":"hi"}' },
      {
        kind: 'decision',
        decision: { action: 'respond', text: 'hi' },
      },
    ])
    expect(result.stopReason).toBe('decision')
    // The runtime asked the provider for a JSON object.
    expect(calls[0]?.body.response_format).toEqual({ type: 'json_object' })
  })

  it('maps a length finish reason to max_tokens', async () => {
    const { fetchImpl } = fakeFetch([
      sse(textDelta('partial answer'), finish('length')),
    ])
    const runtime = new OpenAIChatRuntime({
      apiKey: 'sk-test',
      model: 'm',
      fetch: fetchImpl,
    })
    const result = await runtime.generate(bundle()).result
    expect(result.stopReason).toBe('max_tokens')
  })

  it('reports capabilities from options', () => {
    const runtime = new OpenAIChatRuntime({
      apiKey: 'sk-test',
      model: 'm',
      maxContextTokens: 64000,
      maxOutputTokens: 4096,
    })
    expect(runtime.capabilities()).toEqual({
      streaming: true,
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
      {
        kind: 'error',
        status: 401,
        payload: { error: { message: 'Invalid API key' } },
      },
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

  it('classifies 429 as retryable and carries Retry-After', async () => {
    const { fetchImpl } = fakeFetch([
      {
        kind: 'error',
        status: 429,
        payload: { error: { message: 'rate limited' } },
        headers: { 'retry-after': '2' },
      },
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
      expect(error.retryAfterMs).toBe(2000)
    }
  })

  it('classifies context-length failures as context-overflow', async () => {
    const { fetchImpl } = fakeFetch([
      {
        kind: 'error',
        status: 400,
        payload: { error: { message: 'context_length_exceeded' } },
      },
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
    const { fetchImpl } = fakeFetch([json({ object: 'list' })])
    const runtime = new OpenAIChatRuntime({
      apiKey: 'sk-test',
      model: 'm',
      fetch: fetchImpl,
    })
    await expect(runtime.generate(bundle()).result).rejects.toThrow(
      ModelProtocolError,
    )
  })

  it('rejects a non-JSON streaming chunk as a protocol error', async () => {
    const text = 'data: {not json}\n\ndata: [DONE]\n\n'
    const fetchImpl: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(text))
            controller.close()
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    const runtime = new OpenAIChatRuntime({
      apiKey: 'sk-test',
      model: 'm',
      fetch: fetchImpl,
    })
    const call = runtime.generate(bundle())
    await expect(call.result).rejects.toThrow(ModelProtocolError)
    // The events iterator still ends (the failure surfaces via result).
    expect(await collect(call.events)).toEqual([])
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
