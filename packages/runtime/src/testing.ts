import { LlmRuntimeError } from './llm-runtime.ts'
import type {
  ContextBundle,
  LlmCall,
  LlmCallOptions,
  LlmCapabilities,
  LlmResult,
  LlmRetryability,
  LlmRuntime,
  LlmStopReason,
  LlmStreamEvent,
  LlmToolCall,
  LlmUsage,
} from './llm-runtime.ts'

/**
 * Deterministic fake LLMRuntime (v1 refactor plan §5.2 P1-9 acceptance).
 * Tests script a sequence of steps; each generate() call consumes one step,
 * replays its stream events, and settles its result. Calls are recorded for
 * assertion, cancellation is honored, and running out of script fails loud
 * instead of inventing output.
 */

export interface FakeLlmRespondStep {
  readonly type: 'respond'
  /** Text deltas streamed in order. */
  readonly deltas?: readonly string[]
  /** Tool intents streamed after the deltas. */
  readonly toolCalls?: readonly LlmToolCall[]
  /** A structured decision streamed as the final event. */
  readonly decision?: unknown
  readonly stopReason?: LlmStopReason
  readonly usage?: Partial<LlmUsage>
  readonly providerMetadata?: Record<string, unknown>
  readonly latencyMs?: number
}

export interface FakeLlmFailStep {
  readonly type: 'fail'
  readonly error:
    | LlmRuntimeError
    | {
        readonly message: string
        readonly retryability: LlmRetryability
        readonly providerCode?: string
        readonly retryAfterMs?: number
      }
}

export type FakeLlmStep = FakeLlmRespondStep | FakeLlmFailStep

export interface CapturedLlmCall {
  readonly bundle: ContextBundle
  readonly options: LlmCallOptions | undefined
}

export interface FakeLlmRuntime extends LlmRuntime {
  /** Every generate() invocation, in order, for assertions. */
  readonly calls: readonly CapturedLlmCall[]
}

export interface CreateFakeLlmRuntimeOptions {
  readonly script: readonly FakeLlmStep[]
  readonly model?: string
  readonly capabilities?: Partial<LlmCapabilities>
  readonly providerId?: string
  /**
   * Delay between streamed events. Zero by default (instant, synchronous
   * tests); a positive value lets tests abort mid-stream and observe the
   * cancelled result, like a real provider.
   */
  readonly stepDelayMs?: number
}

function toError(failure: FakeLlmFailStep['error']): LlmRuntimeError {
  if (failure instanceof LlmRuntimeError) return failure
  return new LlmRuntimeError(
    failure.message,
    failure.retryability,
    failure.providerCode,
    failure.retryAfterMs,
  )
}

/** Rough, fully deterministic input-token stand-in for unscripted usage. */
function inputTokenHeuristic(bundle: ContextBundle): number {
  let chars = 0
  for (const message of bundle.messages) {
    chars += message.content.length
  }
  return Math.ceil(chars / 4)
}

function stopReasonFor(step: FakeLlmRespondStep): LlmStopReason {
  if (step.stopReason !== undefined) return step.stopReason
  if (step.decision !== undefined) return 'decision'
  if ((step.toolCalls?.length ?? 0) > 0) return 'tool_calls'
  return 'end_turn'
}

export function createFakeLlmRuntime(
  options: CreateFakeLlmRuntimeOptions,
): FakeLlmRuntime {
  const script = [...options.script]
  const calls: CapturedLlmCall[] = []
  const capabilities: LlmCapabilities = {
    streaming: true,
    tools: true,
    structuredDecisions: true,
    maxContextTokens: 128000,
    maxOutputTokens: 8192,
    ...options.capabilities,
  }

  const stepDelayMs = options.stepDelayMs ?? 0

  function delay(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, stepDelayMs))
  }

  /**
   * Replays one scripted step. Each consumer (events iterable, result
   * settlement) drains its own replay — async generators are single-use —
   * and both see the identical, deterministic sequence.
   */
  async function* replay(
    step: FakeLlmRespondStep,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<LlmStreamEvent> {
    const emit = async function* (
      event: LlmStreamEvent,
    ): AsyncGenerator<LlmStreamEvent> {
      if (stepDelayMs > 0) await delay()
      yield event
    }
    for (const delta of step.deltas ?? []) {
      if (signal?.aborted) return
      yield* emit({ kind: 'message-delta', delta })
    }
    for (const call of step.toolCalls ?? []) {
      if (signal?.aborted) return
      yield* emit({ kind: 'tool-intent', call })
    }
    if (step.decision !== undefined && !(signal?.aborted ?? false)) {
      yield* emit({ kind: 'decision', decision: step.decision })
    }
  }

  function settle(
    step: FakeLlmRespondStep,
    bundle: ContextBundle,
    stopReason: LlmStopReason,
    startedAt: number,
  ): LlmResult {
    const streamedChars = (step.deltas ?? []).reduce(
      (total, delta) => total + delta.length,
      0,
    )
    const inputTokens = step.usage?.inputTokens ?? inputTokenHeuristic(bundle)
    const outputTokens = step.usage?.outputTokens ?? streamedChars
    return {
      stopReason,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: step.usage?.totalTokens ?? inputTokens + outputTokens,
        costUsd: step.usage?.costUsd,
      },
      provider: {
        id: options.providerId ?? 'fake',
        metadata: step.providerMetadata,
      },
      latencyMs: step.latencyMs ?? Date.now() - startedAt,
    }
  }

  return {
    model: options.model ?? 'fake-model',
    calls,
    capabilities: () => capabilities,
    generate(bundle: ContextBundle, callOptions?: LlmCallOptions): LlmCall {
      calls.push({ bundle, options: callOptions })
      const step = script.shift()
      const startedAt = Date.now()

      const events =
        step?.type === 'respond'
          ? replay(step, callOptions?.signal)
          : emptyStream()

      const result = (async (): Promise<LlmResult> => {
        if (step === undefined) {
          throw new LlmRuntimeError(
            'Fake LLMRuntime script exhausted; every generate() needs a scripted step',
            'fatal',
          )
        }
        if (step.type === 'fail') {
          throw toError(step.error)
        }
        // The result settles when the generation itself finishes — on its
        // own replay schedule, not the consumer's — so mid-stream aborts
        // produce a cancelled result exactly like a real provider.
        const drain = replay(step, callOptions?.signal)
        while ((await drain.next()).done !== true) {
          // advance until the generation finishes
        }
        const stopReason = callOptions?.signal?.aborted
          ? 'cancelled'
          : stopReasonFor(step)
        return settle(step, bundle, stopReason, startedAt)
      })()

      return { events, result }
    },
  }
}

async function* emptyStream(): AsyncGenerator<LlmStreamEvent> {
  // Failures and exhausted scripts stream nothing; the result carries the
  // outcome.
}
