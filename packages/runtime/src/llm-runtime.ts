/**
 * The LLMRuntime contract (architecture §10.2, v1 refactor plan §5.2 P1-9).
 *
 * An LLMRuntime is a stateless, per-model inference seam: the AgentLoop
 * passes a fully assembled {@link ContextBundle} for every call and owns
 * all message state itself — providers never hold the messages array. The
 * runtime streams message deltas, tool intents, and structured decisions,
 * settles with usage/provider/latency statistics, honors cancellation, and
 * classifies its errors so the loop can retry, shrink context, or fail.
 *
 * This module is dependency-free TypeScript on purpose: the AgentLoop
 * (this package), provider adapters (`adapters/models/*`), and tests all
 * consume it without dragging provider SDKs or the kernel into each other.
 */

/** One tool invocation the model wants performed. */
export interface LlmToolCall {
  readonly callId: string
  readonly toolId: string
  readonly input: unknown
}

/** A tool declared in a ContextBundle, with a JSON Schema for its input. */
export interface LlmToolSpec {
  readonly id: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

export type LlmMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string }
  | {
      readonly role: 'assistant'
      readonly content: string
      readonly toolCalls?: readonly LlmToolCall[] | undefined
    }
  | {
      readonly role: 'tool'
      readonly callId: string
      readonly toolId: string
      readonly content: string
      readonly isError?: boolean | undefined
    }

/**
 * The standardized input for one model call. Assembled by the AgentLoop
 * (context policy, memory view, skills, tool declarations); the runtime
 * never mutates or remembers it.
 */
export interface ContextBundle {
  readonly messages: readonly LlmMessage[]
  readonly tools: readonly LlmToolSpec[]
  /**
   * JSON Schema the model's final output should satisfy. Runtimes that
   * support structured decisions emit a `decision` stream event instead of
   * (or alongside) plain text.
   */
  readonly decisionSchema?: Record<string, unknown> | undefined
}

export interface LlmCallOptions {
  /** Aborts the call; the result settles with `stopReason: 'cancelled'`. */
  readonly signal?: AbortSignal | undefined
  readonly maxOutputTokens?: number | undefined
  readonly temperature?: number | undefined
  readonly timeoutMs?: number | undefined
}

export type LlmStreamEvent =
  | { readonly kind: 'message-delta'; readonly delta: string }
  | { readonly kind: 'tool-intent'; readonly call: LlmToolCall }
  | { readonly kind: 'decision'; readonly decision: unknown }

export type LlmStopReason =
  'end_turn' | 'tool_calls' | 'decision' | 'max_tokens' | 'cancelled'

export interface LlmUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  /** Best-known dollar cost of the call, when the provider reports one. */
  readonly costUsd?: number | undefined
}

export interface LlmProviderInfo {
  readonly id: string
  readonly metadata?: Record<string, unknown> | undefined
}

export interface LlmResult {
  readonly stopReason: LlmStopReason
  readonly usage: LlmUsage
  readonly provider: LlmProviderInfo
  readonly latencyMs: number
}

/** One in-flight generation: consumed events, then the settled result. */
export interface LlmCall {
  readonly events: AsyncIterable<LlmStreamEvent>
  readonly result: Promise<LlmResult>
}

// ---------------------------------------------------------------------------
// Error taxonomy and retry classification
// ---------------------------------------------------------------------------

export type LlmRetryability = 'retryable' | 'fatal' | 'context-overflow'

/**
 * The error every runtime failure rejects `result` with. `retryability`
 * tells the AgentLoop what may happen next: retry (with backoff), shrink
 * the context bundle, or propagate.
 */
export class LlmRuntimeError extends Error {
  constructor(
    message: string,
    readonly retryability: LlmRetryability,
    readonly providerCode?: string | undefined,
    /** Suggested backoff from the provider (e.g. Retry-After), if any. */
    readonly retryAfterMs?: number | undefined,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'LlmRuntimeError'
  }
}

export function isLlmRuntimeError(error: unknown): error is LlmRuntimeError {
  return error instanceof LlmRuntimeError
}

/**
 * How an arbitrary thrown error should be treated. Adapters classify the
 * provider errors they know; anything unclassified defaults to retryable,
 * since transient transport failures dominate and callers cap retries.
 */
export function classifyLlmError(error: unknown): LlmRetryability {
  if (isLlmRuntimeError(error)) return error.retryability
  return 'retryable'
}

// ---------------------------------------------------------------------------
// Capability discovery
// ---------------------------------------------------------------------------

export interface LlmCapabilities {
  readonly streaming: boolean
  readonly tools: boolean
  readonly structuredDecisions: boolean
  readonly maxContextTokens: number
  readonly maxOutputTokens: number
}

/** A stateless inference runtime bound to exactly one model. */
export interface LlmRuntime {
  /** Model id this instance serves, as referenced by bundles and structure. */
  readonly model: string
  capabilities(): LlmCapabilities
  generate(bundle: ContextBundle, options?: LlmCallOptions): LlmCall
}
