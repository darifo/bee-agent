import { LlmRuntimeError } from '@bee-agent/runtime'
import type {
  ContextBundle,
  LlmCall,
  LlmCallOptions,
  LlmCapabilities,
  LlmMessage,
  LlmResult,
  LlmRuntime,
  LlmStreamEvent,
  LlmToolCall,
} from '@bee-agent/runtime'
import { ModelProtocolError, ModelProviderError } from './errors.ts'
import type { HttpOptions } from './shared.ts'
import {
  DEFAULT_OPENAI_BASE_URL,
  joinUrl,
  postForStream,
  requireRecord,
} from './shared.ts'

/**
 * An {@link LlmRuntime} over the OpenAI-compatible `/chat/completions`
 * surface. It is stateless: every `generate` call receives a fully assembled
 * {@link ContextBundle} and returns one in-flight call — there is no message
 * history on the instance and no internal tool loop; tool intents stream out
 * and the AgentLoop decides what to run next.
 *
 * Streaming is on by default (`stream: true` + SSE). A response that arrives
 * as plain JSON (a proxy or provider ignoring the flag, or
 * `options.streaming: false`) falls back to the buffered path, so both wire
 * shapes produce identical events and results.
 */

export interface OpenAIChatRuntimeOptions extends HttpOptions {
  readonly apiKey: string
  readonly model: string
  readonly baseUrl?: string | undefined
  readonly temperature?: number | undefined
  /** Defaults to 8192; reported through {@link LlmRuntime.capabilities}. */
  readonly maxOutputTokens?: number | undefined
  /** Defaults to 128000; reported through {@link LlmRuntime.capabilities}. */
  readonly maxContextTokens?: number | undefined
  /** Provider id reported in every result. Defaults to the base url host. */
  readonly providerId?: string | undefined
  /** Request SSE streaming; on by default. JSON responses still parse. */
  readonly streaming?: boolean | undefined
}

interface WireToolCall {
  readonly id: string
  readonly type: string
  readonly function: { readonly name: string; readonly arguments: string }
}

interface WireMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content?: string | null
  readonly tool_calls?: readonly WireToolCall[]
  readonly tool_call_id?: string
}

interface Completion {
  readonly stopReason: LlmResult['stopReason']
  readonly usage: LlmResult['usage']
}

/** Tool-call fragments accumulate across SSE chunks, keyed by chunk index. */
interface ToolCallFragment {
  id?: string
  name: string
  args: string
}

const STREAM_DONE = Symbol('stream-done')

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/** OpenAI function names allow `[a-zA-Z0-9_-]` only. */
function toFunctionName(toolId: string): string {
  const sanitized = toolId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return sanitized.length > 0 ? sanitized.slice(0, 64) : 'tool'
}

/**
 * Parses tool arguments, recording malformed JSON on the call instead of
 * silently executing with an empty input: the AgentLoop feeds the error back
 * as a tool result so the model can correct its arguments.
 */
function parseToolArguments(raw: string): {
  input: unknown
  inputError: string | undefined
} {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { input: {}, inputError: undefined }
  }
  try {
    return { input: JSON.parse(raw) as unknown, inputError: undefined }
  } catch {
    const excerpt = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw
    return {
      input: {},
      inputError: `Tool arguments were not valid JSON: ${excerpt}`,
    }
  }
}

export class OpenAIChatRuntime implements LlmRuntime {
  readonly model: string
  readonly #baseUrl: string
  readonly #apiKey: string
  readonly #temperature: number | undefined
  readonly #maxOutputTokens: number
  readonly #maxContextTokens: number
  readonly #providerId: string
  readonly #http: HttpOptions
  readonly #streaming: boolean

  constructor(options: OpenAIChatRuntimeOptions) {
    this.model = options.model
    this.#baseUrl = options.baseUrl ?? DEFAULT_OPENAI_BASE_URL
    this.#apiKey = options.apiKey
    this.#temperature = options.temperature
    this.#maxOutputTokens = options.maxOutputTokens ?? 8192
    this.#maxContextTokens = options.maxContextTokens ?? 128_000
    this.#providerId =
      options.providerId ??
      this.#baseUrl.replace(/^https?:\/\//, '').split('/')[0] ??
      'openai'
    this.#http = { fetch: options.fetch, timeoutMs: options.timeoutMs }
    this.#streaming = options.streaming ?? true
  }

  capabilities(): LlmCapabilities {
    return {
      streaming: this.#streaming,
      tools: true,
      structuredDecisions: true,
      maxContextTokens: this.#maxContextTokens,
      maxOutputTokens: this.#maxOutputTokens,
    }
  }

  generate(bundle: ContextBundle, options?: LlmCallOptions): LlmCall {
    const startedAt = Date.now()

    // Events produced by the single background consumption of the response
    // are queued here; `events` drains the queue while the request is still
    // in flight, and a caller that only awaits `result` simply never drains.
    const queue: (LlmStreamEvent | typeof STREAM_DONE)[] = []
    let wake: (() => void) | undefined
    const notify = (): void => {
      const resolve = wake
      wake = undefined
      resolve?.()
    }
    const push = (event: LlmStreamEvent): void => {
      queue.push(event)
      notify()
    }

    const run = this.#run(bundle, options, push)
    // Close the queue on settlement so a drained `events` iterator ends even
    // when the run failed (the failure surfaces through `result`).
    const close = (): void => {
      queue.push(STREAM_DONE)
      notify()
    }
    void run.then(close, close)

    const events = (async function* (): AsyncGenerator<LlmStreamEvent> {
      while (true) {
        const item = queue.shift()
        if (item === undefined) {
          await new Promise<void>((resolve) => {
            wake = resolve
          })
          continue
        }
        if (item === STREAM_DONE) return
        yield item
      }
    })()

    const result = (async (): Promise<LlmResult> => {
      const completion = await run
      const latencyMs = Date.now() - startedAt
      if (completion === 'cancelled') {
        return {
          stopReason: 'cancelled',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          provider: { id: this.#providerId },
          latencyMs,
        }
      }
      return {
        stopReason: completion.stopReason,
        usage: completion.usage,
        provider: { id: this.#providerId },
        latencyMs,
      }
    })()

    return { events, result }
  }

  async #run(
    bundle: ContextBundle,
    options: LlmCallOptions | undefined,
    push: (event: LlmStreamEvent) => void,
  ): Promise<Completion | 'cancelled'> {
    const functionNames = new Map<string, string>()
    const toolDefinitions = bundle.tools.map((tool) => {
      const name = toFunctionName(tool.id)
      functionNames.set(name, tool.id)
      return {
        type: 'function',
        function: {
          name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }
    })

    const body: Record<string, unknown> = {
      model: this.model,
      messages: bundle.messages.map((message) => this.#toWire(message)),
      ...(this.#temperature !== undefined
        ? { temperature: this.#temperature }
        : {}),
      ...(options?.maxOutputTokens !== undefined
        ? { max_tokens: options.maxOutputTokens }
        : {}),
      ...(toolDefinitions.length > 0 ? { tools: toolDefinitions } : {}),
      ...(bundle.decisionSchema !== undefined
        ? { response_format: { type: 'json_object' } }
        : {}),
      ...(this.#streaming
        ? {
            stream: true,
            stream_options: { include_usage: true },
          }
        : {}),
    }

    let response: Response
    try {
      response = await postForStream(
        joinUrl(this.#baseUrl, '/chat/completions'),
        this.#apiKey,
        body,
        this.#http,
        options?.signal,
      )
    } catch (error) {
      if (isAbortError(error) || options?.signal?.aborted) return 'cancelled'
      throw classifyProviderError(error)
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('text/event-stream')) {
      return await this.#runSse(response, functionNames, bundle, push, options)
    }
    return await this.#runBuffered(
      response,
      functionNames,
      bundle,
      push,
      options,
    )
  }

  /** Consumes an SSE body, pushing message deltas as they arrive. */
  async #runSse(
    response: Response,
    functionNames: ReadonlyMap<string, string>,
    bundle: ContextBundle,
    push: (event: LlmStreamEvent) => void,
    options: LlmCallOptions | undefined,
  ): Promise<Completion | 'cancelled'> {
    if (response.body === null) {
      throw new ModelProtocolError('Streaming response has no body', response)
    }
    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    const fragments = new Map<number, ToolCallFragment>()
    let buffer = ''
    let content = ''
    let finishReason: string | undefined
    let usage: LlmResult['usage'] | undefined

    const handleChunk = (chunk: unknown): void => {
      if (!isRecord(chunk)) return
      const usageRecord = chunk.usage
      if (isRecord(usageRecord)) {
        usage = {
          inputTokens: numberField(usageRecord, 'prompt_tokens'),
          outputTokens: numberField(usageRecord, 'completion_tokens'),
          totalTokens: numberField(usageRecord, 'total_tokens'),
        }
      }
      const choices = chunk.choices
      if (!Array.isArray(choices) || choices.length === 0) return
      const choice = choices[0]
      if (!isRecord(choice)) return
      if (typeof choice.finish_reason === 'string') {
        finishReason = choice.finish_reason
      }
      const delta = choice.delta
      if (!isRecord(delta)) return
      const deltaContent = delta.content
      if (typeof deltaContent === 'string' && deltaContent.length > 0) {
        content += deltaContent
        push({ kind: 'message-delta', delta: deltaContent })
      }
      const deltaToolCalls = delta.tool_calls
      if (!Array.isArray(deltaToolCalls)) return
      for (const wire of deltaToolCalls) {
        if (!isRecord(wire)) continue
        const index = typeof wire.index === 'number' ? wire.index : 0
        let fragment = fragments.get(index)
        if (fragment === undefined) {
          fragment = { name: '', args: '' }
          fragments.set(index, fragment)
        }
        if (typeof wire.id === 'string') fragment.id = wire.id
        const fn = isRecord(wire.function) ? wire.function : undefined
        if (fn !== undefined && typeof fn.name === 'string') {
          fragment.name += fn.name
        }
        if (fn !== undefined && typeof fn.arguments === 'string') {
          fragment.args += fn.arguments
        }
      }
    }

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let separator = findSeparator(buffer)
        while (separator !== undefined) {
          const rawEvent = buffer.slice(0, separator.index)
          buffer = buffer.slice(separator.index + separator.length)
          const data = sseEventData(rawEvent)
          if (data === '[DONE]') {
            return this.#settleSse(
              content,
              fragments,
              finishReason,
              usage,
              functionNames,
              bundle,
              push,
            )
          }
          if (data !== undefined) handleChunk(parseChunk(data))
          separator = findSeparator(buffer)
        }
      }
      // Stream ended without [DONE]; settle with whatever arrived.
      const tail = sseEventData(buffer + decoder.decode())
      if (tail !== undefined && tail !== '[DONE]') {
        handleChunk(parseChunk(tail))
      }
    } catch (error) {
      if (isAbortError(error) || options?.signal?.aborted) return 'cancelled'
      if (error instanceof ModelProtocolError) throw error
      throw classifyProviderError(error)
    } finally {
      void reader.cancel().catch(() => {})
    }
    return this.#settleSse(
      content,
      fragments,
      finishReason,
      usage,
      functionNames,
      bundle,
      push,
    )
  }

  #settleSse(
    content: string,
    fragments: ReadonlyMap<number, ToolCallFragment>,
    finishReason: string | undefined,
    usage: LlmResult['usage'] | undefined,
    functionNames: ReadonlyMap<string, string>,
    bundle: ContextBundle,
    push: (event: LlmStreamEvent) => void,
  ): Completion {
    const toolCalls = settleToolCalls(fragments, functionNames)
    const decision = parseDecision(bundle, content)
    for (const call of toolCalls) push({ kind: 'tool-intent', call })
    if (decision !== undefined) push({ kind: 'decision', decision })
    return {
      stopReason: stopReasonFor(toolCalls, decision, finishReason),
      usage: usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }
  }

  /** Buffered JSON path: providers and proxies that ignore `stream`. */
  async #runBuffered(
    response: Response,
    functionNames: ReadonlyMap<string, string>,
    bundle: ContextBundle,
    push: (event: LlmStreamEvent) => void,
    options: LlmCallOptions | undefined,
  ): Promise<Completion | 'cancelled'> {
    let text: string
    try {
      text = await response.text()
    } catch (error) {
      if (isAbortError(error) || options?.signal?.aborted) return 'cancelled'
      throw classifyProviderError(error)
    }
    let payload: unknown
    try {
      payload = text.length > 0 ? JSON.parse(text) : undefined
    } catch {
      throw new ModelProtocolError('Response body is not JSON', text)
    }
    const responseBody = requireRecord(payload, 'payload')
    const choices = responseBody.choices
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new ModelProtocolError(
        'choices[] is missing from the response',
        payload,
      )
    }
    const choice = requireRecord(choices[0], 'choices[0]')
    const message = requireRecord(choice.message, 'choices[0].message')
    const content = typeof message.content === 'string' ? message.content : ''
    const wireToolCalls = Array.isArray(message.tool_calls)
      ? (message.tool_calls as readonly WireToolCall[])
      : []
    const usageRecord = isRecord(responseBody.usage) ? responseBody.usage : {}
    const finishReason =
      typeof choices[0]?.finish_reason === 'string'
        ? (choices[0] as { finish_reason: string }).finish_reason
        : 'stop'

    const toolCalls: LlmToolCall[] = wireToolCalls.map((call) => {
      const parsed = parseToolArguments(call.function.arguments)
      return {
        callId: call.id,
        toolId: functionNames.get(call.function.name) ?? call.function.name,
        input: parsed.input,
        ...(parsed.inputError === undefined
          ? {}
          : { inputError: parsed.inputError }),
      }
    })

    if (content.length > 0) push({ kind: 'message-delta', delta: content })
    for (const call of toolCalls) push({ kind: 'tool-intent', call })
    const decision = parseDecision(bundle, content)
    if (decision !== undefined) push({ kind: 'decision', decision })

    return {
      stopReason: stopReasonFor(toolCalls, decision, finishReason),
      usage: {
        inputTokens: numberField(usageRecord, 'prompt_tokens'),
        outputTokens: numberField(usageRecord, 'completion_tokens'),
        totalTokens: numberField(usageRecord, 'total_tokens'),
      },
    }
  }

  #toWire(message: LlmMessage): WireMessage {
    switch (message.role) {
      case 'system':
      case 'user':
        return { role: message.role, content: message.content }
      case 'assistant':
        return {
          role: 'assistant',
          content: message.content,
          ...(message.toolCalls !== undefined && message.toolCalls.length > 0
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.callId,
                  type: 'function',
                  function: {
                    name: toFunctionName(call.toolId),
                    arguments: JSON.stringify(call.input ?? {}),
                  },
                })),
              }
            : {}),
        }
      case 'tool':
        return {
          role: 'tool',
          tool_call_id: message.callId,
          content: message.content,
        }
    }
  }
}

function settleToolCalls(
  fragments: ReadonlyMap<number, ToolCallFragment>,
  functionNames: ReadonlyMap<string, string>,
): LlmToolCall[] {
  const calls: LlmToolCall[] = []
  for (const index of [...fragments.keys()].sort((a, b) => a - b)) {
    const fragment = fragments.get(index)
    if (fragment === undefined) continue
    if (fragment.name === '' && fragment.args === '') continue
    const parsed = parseToolArguments(fragment.args)
    calls.push({
      callId: fragment.id ?? `call-${index}`,
      toolId: functionNames.get(fragment.name) ?? fragment.name,
      input: parsed.input,
      ...(parsed.inputError === undefined
        ? {}
        : { inputError: parsed.inputError }),
    })
  }
  return calls
}

function parseDecision(bundle: ContextBundle, content: string): unknown {
  if (bundle.decisionSchema === undefined || content.length === 0) return
  try {
    const parsed: unknown = JSON.parse(content)
    if (parsed !== null && typeof parsed === 'object') return parsed
  } catch {
    // malformed decision: treat content as plain text
  }
  return undefined
}

function stopReasonFor(
  toolCalls: readonly LlmToolCall[],
  decision: unknown,
  finishReason: string | undefined,
): LlmResult['stopReason'] {
  if (toolCalls.length > 0) return 'tool_calls'
  if (decision !== undefined) return 'decision'
  if (finishReason === 'length' || finishReason === 'max_tokens') {
    return 'max_tokens'
  }
  return 'end_turn'
}

function findSeparator(
  buffer: string,
): { index: number; length: number } | undefined {
  const index = buffer.search(/\r?\n\r?\n/)
  if (index === -1) return undefined
  return { index, length: buffer.slice(index, index + 2) === '\r\n' ? 4 : 2 }
}

function sseEventData(rawEvent: string): string | undefined {
  const data: string[] = []
  for (const line of rawEvent.split(/\r?\n/)) {
    if (line.startsWith(':')) continue // keep-alive comment
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
  }
  if (data.length === 0) return undefined
  return data.join('\n')
}

function parseChunk(data: string): unknown {
  try {
    return JSON.parse(data) as unknown
  } catch {
    throw new ModelProtocolError(
      'Streaming chunk is not valid JSON',
      data.slice(0, 200),
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Maps provider failures onto the LLMRuntime error taxonomy so the
 * AgentLoop can retry, shrink context, or fail without peeking at transport
 * details. Retry-After hints survive as `retryAfterMs`.
 */
function classifyProviderError(error: unknown): Error {
  if (error instanceof ModelProviderError) {
    const status = error.status ?? 0
    const retryAfterMs =
      typeof error.retryAfterMs === 'number' && error.retryAfterMs > 0
        ? error.retryAfterMs
        : undefined
    if (status === 401 || status === 403) {
      return new LlmRuntimeError(
        error.message,
        'fatal',
        String(status),
        retryAfterMs,
      )
    }
    if (status === 429) {
      return new LlmRuntimeError(
        error.message,
        'retryable',
        '429',
        retryAfterMs,
      )
    }
    if (status >= 500) {
      return new LlmRuntimeError(
        error.message,
        'retryable',
        String(status),
        retryAfterMs,
      )
    }
    if (/context|length|token/i.test(error.message)) {
      return new LlmRuntimeError(
        error.message,
        'context-overflow',
        String(status),
      )
    }
    return new LlmRuntimeError(
      error.message,
      'fatal',
      String(status),
      retryAfterMs,
    )
  }
  if (error instanceof Error) {
    // Timeouts and transport failures are transient.
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return new LlmRuntimeError(error.message, 'retryable')
    }
    return new LlmRuntimeError(error.message, 'retryable')
  }
  return new LlmRuntimeError(String(error), 'fatal')
}
