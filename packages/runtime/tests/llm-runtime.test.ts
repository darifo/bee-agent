import { describe, expect, it } from 'vitest'
import {
  LlmRuntimeError,
  classifyLlmError,
  isLlmRuntimeError,
} from '../src/llm-runtime.js'
import type { LlmStreamEvent } from '../src/llm-runtime.js'
import { createFakeLlmRuntime } from '../src/testing.js'
import type { ContextBundle } from '../src/index.js'

function bundle(overrides: Partial<ContextBundle> = {}): ContextBundle {
  return {
    messages: [
      { role: 'system', content: 'You are Bee.' },
      { role: 'user', content: 'Summarize this document.' },
    ],
    tools: [
      {
        id: 'calculator',
        description: 'Arithmetic',
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('LLMRuntime contract via the fake', () => {
  it('streams message deltas in order and settles with end_turn', async () => {
    const llm = createFakeLlmRuntime({
      script: [{ type: 'respond', deltas: ['Hello', ', ', 'world'] }],
    })

    const call = llm.generate(bundle())
    const events = await collect(call.events)
    const result = await call.result

    expect(events).toEqual([
      { kind: 'message-delta', delta: 'Hello' },
      { kind: 'message-delta', delta: ', ' },
      { kind: 'message-delta', delta: 'world' },
    ])
    expect(result.stopReason).toBe('end_turn')
    expect(result.provider.id).toBe('fake')
    expect(result.usage.outputTokens).toBe(12)
    expect(result.usage.inputTokens).toBeGreaterThan(0)
    expect(result.usage.totalTokens).toBe(
      result.usage.inputTokens + result.usage.outputTokens,
    )
  })

  it('streams tool intents and settles with tool_calls', async () => {
    const llm = createFakeLlmRuntime({
      script: [
        {
          type: 'respond',
          deltas: ['Let me compute.'],
          toolCalls: [
            { callId: 'call-1', toolId: 'calculator', input: { a: 1 } },
          ],
        },
      ],
    })

    const call = llm.generate(bundle())
    const events = await collect(call.events)
    const result = await call.result

    expect(events.map((event) => event.kind)).toEqual([
      'message-delta',
      'tool-intent',
    ])
    expect(events[1]).toEqual({
      kind: 'tool-intent',
      call: { callId: 'call-1', toolId: 'calculator', input: { a: 1 } },
    })
    expect(result.stopReason).toBe('tool_calls')
  })

  it('streams a structured decision and settles with decision', async () => {
    const decision = { action: 'respond', confidence: 0.9 }
    const llm = createFakeLlmRuntime({
      script: [{ type: 'respond', decision }],
    })
    const input = bundle({ decisionSchema: { type: 'object' } })

    const call = llm.generate(input)
    const events = await collect(call.events)
    const result = await call.result

    expect(events).toEqual([{ kind: 'decision', decision }])
    expect(result.stopReason).toBe('decision')
  })

  it('records every call bundle and options for assertions', async () => {
    const llm = createFakeLlmRuntime({
      script: [
        { type: 'respond', deltas: ['a'] },
        { type: 'respond', deltas: ['b'] },
      ],
    })
    const first = bundle()
    const second = bundle({
      messages: [...first.messages, { role: 'user', content: 'again' }],
    })

    await llm.generate(first).result
    const signal = new AbortController().signal
    await llm.generate(second, { signal, maxOutputTokens: 10 }).result

    expect(llm.calls).toHaveLength(2)
    expect(llm.calls[0]?.bundle).toBe(first)
    expect(llm.calls[1]?.bundle).toBe(second)
    expect(llm.calls[1]?.options?.maxOutputTokens).toBe(10)
    expect(llm.calls[1]?.options?.signal).toBe(signal)
    expect(llm.model).toBe('fake-model')
  })

  it('honors usage, provider metadata, and latency overrides', async () => {
    const llm = createFakeLlmRuntime({
      script: [
        {
          type: 'respond',
          deltas: ['x'],
          usage: {
            inputTokens: 100,
            outputTokens: 5,
            totalTokens: 105,
            costUsd: 0.002,
          },
          providerMetadata: { finish: 'stop' },
          latencyMs: 42,
        },
      ],
    })

    const result = await llm.generate(bundle()).result
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 5,
      totalTokens: 105,
      costUsd: 0.002,
    })
    expect(result.provider.metadata).toEqual({ finish: 'stop' })
    expect(result.latencyMs).toBe(42)
  })

  it('reports capabilities from overrides', () => {
    const llm = createFakeLlmRuntime({
      script: [],
      capabilities: { streaming: false, maxContextTokens: 8000 },
    })
    expect(llm.capabilities()).toEqual({
      streaming: false,
      tools: true,
      structuredDecisions: true,
      maxContextTokens: 8000,
      maxOutputTokens: 8192,
    })
  })
})

describe('LLMRuntime failure semantics', () => {
  it('rejects the result with classified runtime errors', async () => {
    const llm = createFakeLlmRuntime({
      script: [
        {
          type: 'fail',
          error: {
            message: 'rate limited',
            retryability: 'retryable',
            providerCode: '429',
            retryAfterMs: 1200,
          },
        },
      ],
    })

    const call = llm.generate(bundle())
    await expect(call.result).rejects.toThrow('rate limited')
    const error = await call.result.catch((caught: unknown) => caught)
    expect(isLlmRuntimeError(error)).toBe(true)
    expect(classifyLlmError(error)).toBe('retryable')
    expect(error).toBeInstanceOf(LlmRuntimeError)
    if (isLlmRuntimeError(error)) {
      expect(error.providerCode).toBe('429')
      expect(error.retryAfterMs).toBe(1200)
    }
    // A failed call streams no events.
    expect(await collect(call.events)).toEqual([])
  })

  it('fails loud when the script is exhausted', async () => {
    const llm = createFakeLlmRuntime({ script: [] })
    await expect(llm.generate(bundle()).result).rejects.toThrow(
      /script exhausted/,
    )
  })

  it('treats unclassified errors as retryable', () => {
    expect(classifyLlmError(new Error('socket hang up'))).toBe('retryable')
    expect(
      classifyLlmError(new LlmRuntimeError('too large', 'context-overflow')),
    ).toBe('context-overflow')
  })
})

describe('LLMRuntime cancellation', () => {
  it('settles cancelled when aborted before the call', async () => {
    const llm = createFakeLlmRuntime({
      script: [{ type: 'respond', deltas: ['hello'] }],
    })
    const controller = new AbortController()
    controller.abort()

    const call = llm.generate(bundle(), { signal: controller.signal })
    const result = await call.result
    expect(result.stopReason).toBe('cancelled')
    expect(await collect(call.events)).toEqual([])
  })

  it('stops streaming mid-flight when aborted between events', async () => {
    const llm = createFakeLlmRuntime({
      script: [{ type: 'respond', deltas: ['one', 'two', 'three'] }],
      stepDelayMs: 20,
    })
    const controller = new AbortController()

    const call = llm.generate(bundle(), { signal: controller.signal })
    const consumed = collect(call.events)
    await delay(30)
    controller.abort()
    const events = await consumed
    const result = await call.result

    expect(events.length).toBeLessThan(3)
    expect(events[0]).toEqual({ kind: 'message-delta', delta: 'one' })
    expect(result.stopReason).toBe('cancelled')
  })
})
