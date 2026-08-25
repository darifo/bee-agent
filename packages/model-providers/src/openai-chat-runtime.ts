import { LlmRuntimeError } from '@bee-agent/runtime'
import type {
  ContextBundle,
  LlmCall,
  LlmCallOptions,
  LlmCapabilities,
  LlmMessage,
  LlmResult,
  LlmRuntime,
  LlmStopReason,
  LlmStreamEvent,
  LlmToolCall,
} from '@bee-agent/runtime'
import { ModelProtocolError, ModelProviderError } from './errors.ts'
import type { HttpOptions } from './shared.ts'
import {
  DEFAULT_OPENAI_BASE_URL,
  joinUrl,
  postJson,
  requireRecord,
} from './shared.ts'

/**
 * An {@link LlmRuntime} over the OpenAI-compatible `/chat/completions`
 * surface. It is stateless: every `generate` call receives a fully assembled
 * {@link ContextBundle} and returns one in-flight call — there is no message
 * history on the instance and no internal tool loop; tool intents stream out
 * and the AgentLoop decides what to run next.
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
}

interface WireToolCall {
  readonly id: string
  readonly function: { readonly name: string; readonly arguments: string }
}

interface WireMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content?: string | null
  readonly tool_calls?: readonly WireToolCall[]
  readonly tool_call_id?: string
}

interface Completion {
  readonly events: readonly LlmStreamEvent[]
  readonly stopReason: LlmStopReason
  readonly usage: LlmResult['usage']
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/** OpenAI function names allow `[a-zA-Z0-9_-]` only. */
function toFunctionName(toolId: string): string {
  const sanitized = toolId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return sanitized.length > 0 ? sanitized.slice(0, 64) : 'tool'
}

function parseArguments(call: WireToolCall): unknown {
  const raw = call.function.arguments
  if (typeof raw !== 'string' || raw.trim().length === 0) return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return {}
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
  }

  capabilities(): LlmCapabilities {
    return {
      streaming: false,
      tools: true,
      structuredDecisions: true,
      maxContextTokens: this.#maxContextTokens,
      maxOutputTokens: this.#maxOutputTokens,
    }
  }

  generate(bundle: ContextBundle, options?: LlmCallOptions): LlmCall {
    const startedAt = Date.now()
    const run = this.#run(bundle, options)

    const events = (async function* () {
      const completion = await run
      if (completion === 'cancelled') return
      for (const event of completion.events) yield event
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
    }

    let payload: unknown
    try {
      payload = await postJson(
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

    const toolCalls: LlmToolCall[] = wireToolCalls.map((call) => ({
      callId: call.id,
      toolId: functionNames.get(call.function.name) ?? call.function.name,
      input: parseArguments(call),
    }))

    const events: LlmStreamEvent[] = []
    if (content.length > 0) {
      events.push({ kind: 'message-delta', delta: content })
    }
    for (const call of toolCalls) {
      events.push({ kind: 'tool-intent', call })
    }

    let decision: unknown
    if (bundle.decisionSchema !== undefined && content.length > 0) {
      try {
        const parsed: unknown = JSON.parse(content)
        if (parsed !== null && typeof parsed === 'object') decision = parsed
      } catch {
        // malformed decision: treat content as plain text
      }
    }
    if (decision !== undefined) {
      events.push({ kind: 'decision', decision })
    }

    return {
      events,
      stopReason: this.#stopReason(toolCalls, decision, finishReason),
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
                    arguments: JSON.stringify(call.input),
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

  #stopReason(
    toolCalls: readonly LlmToolCall[],
    decision: unknown,
    finishReason: string,
  ): LlmStopReason {
    if (toolCalls.length > 0) return 'tool_calls'
    if (decision !== undefined) return 'decision'
    if (finishReason === 'length' || finishReason === 'max_tokens') {
      return 'max_tokens'
    }
    return 'end_turn'
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
 * details.
 */
function classifyProviderError(error: unknown): Error {
  if (error instanceof ModelProviderError) {
    const status = error.status ?? 0
    if (status === 401 || status === 403) {
      return new LlmRuntimeError(error.message, 'fatal', String(status))
    }
    if (status === 429) {
      return new LlmRuntimeError(error.message, 'retryable', '429')
    }
    if (status >= 500) {
      return new LlmRuntimeError(error.message, 'retryable', String(status))
    }
    if (/context|length|token/i.test(error.message)) {
      return new LlmRuntimeError(
        error.message,
        'context-overflow',
        String(status),
      )
    }
    return new LlmRuntimeError(error.message, 'fatal', String(status))
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
