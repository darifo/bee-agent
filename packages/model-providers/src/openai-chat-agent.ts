import type { ToolResult } from '@bee-agent/contracts'
import type {
  Agent,
  AgentResult,
  AgentRunContext,
  MockAgentOutput,
} from '@bee-agent/runtime'
import { ModelProtocolError } from './errors.js'
import type { HttpOptions } from './shared.js'
import {
  DEFAULT_OPENAI_BASE_URL,
  joinUrl,
  postJson,
  requireRecord,
} from './shared.js'

export interface OpenAIChatAgentOptions extends HttpOptions {
  /** Defaults to `agent.openai-chat`. */
  readonly id?: string | undefined
  /**
   * OpenAI-compatible API base, for example `https://api.deepseek.com` or
   * `https://api.openai.com/v1`; `/chat/completions` is appended.
   */
  readonly baseUrl?: string | undefined
  readonly apiKey: string
  readonly model: string
  readonly systemPrompt?: string | undefined
  readonly temperature?: number | undefined
  /** Bound on model turns (tool-call rounds included); defaults to 8. */
  readonly maxTurns?: number | undefined
}

interface ChatToolCall {
  readonly id: string
  readonly function: { readonly name: string; readonly arguments: string }
}

interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content?: string | null
  readonly tool_calls?: readonly ChatToolCall[]
  readonly tool_call_id?: string
}

/** One assistant turn as returned by the provider. */
interface AssistantTurn {
  readonly role: 'assistant'
  readonly content: string | null
  readonly tool_calls: readonly ChatToolCall[] | undefined
}

const DEFAULT_MAX_TURNS = 8

/** OpenAI function names allow `[a-zA-Z0-9_-]` only. */
function toFunctionName(toolId: string): string {
  const sanitized = toolId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return sanitized.length > 0 ? sanitized.slice(0, 64) : 'tool'
}

/**
 * Chat agent over the OpenAI-compatible `/chat/completions` surface. It
 * runs a bounded turn loop: model text becomes `agent.message` events,
 * requested tools go through the runtime's policy-intercepted
 * `callTool`, and their results are fed back as tool messages until the
 * model answers without tool calls. Output mirrors {@link MockAgentOutput}.
 */
export class OpenAIChatAgent implements Agent {
  readonly id: string
  readonly #baseUrl: string
  readonly #apiKey: string
  readonly #model: string
  readonly #systemPrompt: string | undefined
  readonly #temperature: number | undefined
  readonly #maxTurns: number
  readonly #http: HttpOptions

  constructor(options: OpenAIChatAgentOptions) {
    this.id = options.id ?? 'agent.openai-chat'
    this.#baseUrl = options.baseUrl ?? DEFAULT_OPENAI_BASE_URL
    this.#apiKey = options.apiKey
    this.#model = options.model
    this.#systemPrompt = options.systemPrompt
    this.#temperature = options.temperature
    this.#maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
    this.#http = { fetch: options.fetch, timeoutMs: options.timeoutMs }
  }

  async run(context: AgentRunContext): Promise<AgentResult> {
    const messages: ChatMessage[] = []
    if (this.#systemPrompt !== undefined) {
      messages.push({ role: 'system', content: this.#systemPrompt })
    }
    messages.push({ role: 'user', content: context.input })

    const tools = context.tools.manifests()
    const functionNames = new Map<string, string>()
    const toolDefinitions = tools.map((manifest) => {
      const name = uniqueFunctionName(manifest.id, functionNames)
      return {
        type: 'function',
        function: {
          name,
          description: manifest.description,
          parameters: manifest.inputSchema,
        },
      }
    })

    const replies: string[] = []
    const toolResults: ToolResult[] = []
    for (let turn = 0; turn < this.#maxTurns; turn += 1) {
      context.throwIfCancelled()
      const assistant = await this.#complete(messages, toolDefinitions)
      if (
        typeof assistant.content === 'string' &&
        assistant.content.length > 0
      ) {
        await context.emitMessage('assistant', assistant.content)
        replies.push(assistant.content)
      }
      const toolCalls = assistant.tool_calls ?? []
      if (toolCalls.length === 0) {
        return { output: { replies, toolResults } satisfies MockAgentOutput }
      }
      messages.push({
        role: 'assistant',
        content: assistant.content,
        ...(assistant.tool_calls !== undefined
          ? { tool_calls: assistant.tool_calls }
          : {}),
      })
      for (const call of toolCalls) {
        context.throwIfCancelled()
        const toolId =
          functionNames.get(call.function.name) ?? call.function.name
        const result = await context.callTool(toolId, parseArguments(call))
        toolResults.push(result)
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(
            result.error !== undefined
              ? { error: result.error }
              : (result.output ?? null),
          ),
        })
      }
    }
    throw new ModelProtocolError(
      `Model kept requesting tools after ${this.#maxTurns} turns`,
    )
  }

  async #complete(
    messages: ChatMessage[],
    tools: readonly unknown[],
  ): Promise<AssistantTurn> {
    const payload = await postJson(
      joinUrl(this.#baseUrl, '/chat/completions'),
      this.#apiKey,
      {
        model: this.#model,
        messages,
        ...(this.#temperature !== undefined
          ? { temperature: this.#temperature }
          : {}),
        ...(tools.length > 0 ? { tools } : {}),
      },
      this.#http,
    )
    const body = requireRecord(payload, 'choices')
    const choices = body.choices
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new ModelProtocolError(
        'choices[] is missing from the response',
        payload,
      )
    }
    const message = requireRecord(choices[0], 'choices[0].message').message
    const assistant = requireRecord(message, 'choices[0].message')
    return {
      role: 'assistant',
      content: typeof assistant.content === 'string' ? assistant.content : null,
      tool_calls: Array.isArray(assistant.tool_calls)
        ? (assistant.tool_calls as readonly ChatToolCall[])
        : undefined,
    }
  }
}

function uniqueFunctionName(
  toolId: string,
  taken: Map<string, string>,
): string {
  const base = toFunctionName(toolId)
  let name = base
  let suffix = 2
  while (taken.has(name)) {
    name = `${base}_${suffix}`
    suffix += 1
  }
  taken.set(name, toolId)
  return name
}

function parseArguments(call: ChatToolCall): Record<string, unknown> {
  const raw = call.function.arguments
  if (typeof raw !== 'string' || raw.trim().length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // fall through: model sent malformed arguments
  }
  return {}
}
