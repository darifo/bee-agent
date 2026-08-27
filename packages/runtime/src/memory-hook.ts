import type { MemoryProvider } from '@bee-agent/knowledge'
import type { ChronicleStore } from '@bee-agent/knowledge'
import { MemoryProviderUnavailableError } from '@bee-agent/knowledge'
import { readThreadEvents, threadStreamId } from '@bee-agent/thread'
import type { ThreadId, TurnId } from '@bee-agent/thread'
import type {
  AgentLoopHookInput,
  AgentLoopRecoverInput,
  AgentLoopResumeInput,
  AgentLoopRunInput,
  AgentLoopTurnResult,
} from './agent-loop.ts'
import type { AgentLoopRetrieveHook } from './agent-loop.ts'

/**
 * Memory ↔ AgentLoop wiring (v1 refactor plan §5.5 WF4-B): recall injects a
 * budgeted memory section as the retrieve hook, and derivation runs near-line
 * after a Turn settles, feeding the thread's completed messages back into the
 * provider. Both directions are deterministic seams — the hook never blocks
 * on an unavailable provider, and derivation failures never fail the Turn.
 */

// ---------------------------------------------------------------------------
// Recall: the retrieve hook
// ---------------------------------------------------------------------------

export interface MemoryRetrieveHookOptions {
  /** Token budget for the recalled section; low-scoring claims drop first. */
  readonly budgetTokens?: number | undefined
  readonly limit?: number | undefined
}

function lastUserText(input: AgentLoopHookInput): string {
  for (let i = input.history.length - 1; i >= 0; i -= 1) {
    const message = input.history[i]!
    if (message.role === 'user' && message.content.trim() !== '') {
      return message.content
    }
  }
  return input.input
}

/**
 * Builds the retrieve hook over a MemoryProvider. An unavailable provider
 * (per `health()`, or a circuit that opens mid-call) skips recall instead of
 * injecting stale or empty memory — the outage itself stays visible through
 * the provider's durable health transitions. Unexpected provider errors
 * propagate — they are bugs, not outages.
 */
export function createMemoryRetrieveHook(
  provider: MemoryProvider,
  options: MemoryRetrieveHookOptions = {},
): AgentLoopRetrieveHook {
  const budgetTokens = options.budgetTokens ?? 512
  const limit = options.limit ?? 8
  return {
    async retrieve(input) {
      const health = await provider.health()
      if (health.status === 'unavailable') return []
      let context
      try {
        context = await provider.buildContext({
          text: lastUserText(input),
          budgetTokens,
          limit,
        })
      } catch (error) {
        if (error instanceof MemoryProviderUnavailableError) return []
        throw error
      }
      if (context.content === '') return []
      return [
        {
          role: 'system',
          content: `Recalled memory about this user and their projects (auto-retrieved; may be imperfect):\n${context.content}`,
        },
      ]
    },
  }
}

// ---------------------------------------------------------------------------
// Derivation: the near-line worker
// ---------------------------------------------------------------------------

export interface MemoryDerivationWorkerOptions {
  readonly store: ChronicleStore
  readonly provider: MemoryProvider
}

export interface MemoryDerivationReport {
  readonly threadId: ThreadId
  readonly turnId: TurnId
  /** Candidates the provider derived from the turn's messages. */
  readonly derived: number
  /** Candidates actually ingested (0 when derivation found nothing). */
  readonly recorded: number
  /** Set when the near-line pass failed; the Turn itself still succeeded. */
  readonly error: string | undefined
}

/**
 * Derives memory from completed Turns. Serialized per worker; failures are
 * captured in the report instead of thrown so a memory hiccup never fails a
 * conversation that already completed.
 */
export class MemoryDerivationWorker {
  readonly #options: MemoryDerivationWorkerOptions
  #tail: Promise<unknown> = Promise.resolve()

  constructor(options: MemoryDerivationWorkerOptions) {
    this.#options = options
  }

  afterTurn(input: {
    readonly threadId: ThreadId
    readonly turnId: TurnId
  }): Promise<MemoryDerivationReport> {
    const run = this.#tail.then(
      () => this.#derive(input),
      () => this.#derive(input),
    )
    this.#tail = run.catch(() => undefined)
    return run
  }

  async #derive(input: {
    readonly threadId: ThreadId
    readonly turnId: TurnId
  }): Promise<MemoryDerivationReport> {
    const { threadId, turnId } = input
    try {
      const messages = []
      const page = await readThreadEvents(this.#options.store, threadId)
      for (const event of page.events) {
        if (event.event !== 'item.completed') continue
        if (event.turnId !== turnId) continue
        const item = event.item
        let role: 'user' | 'assistant' | 'tool' | undefined
        let content: string | undefined
        if (item.type === 'message') {
          if (
            item.payload.role === 'user' ||
            item.payload.role === 'assistant'
          ) {
            role = item.payload.role
            content = item.payload.content
          }
        } else if (item.type === 'tool_call') {
          role = 'tool'
          content =
            item.payload.content ??
            (typeof item.payload.output === 'string'
              ? item.payload.output
              : JSON.stringify(item.payload.output))
        }
        if (role === undefined || (content ?? '') === '') continue
        messages.push({
          role,
          content: content!,
          provenance: {
            streamId: threadStreamId(threadId),
            sequence: event.sequence,
            threadId,
            turnId,
            itemId: item.id,
          },
        })
      }

      const derived = await this.#options.provider.derive({
        threadId,
        turnId,
        messages,
      })
      if (derived.claims.length === 0 && derived.observations.length === 0) {
        return { threadId, turnId, derived: 0, recorded: 0, error: undefined }
      }
      const ingested = await this.#options.provider.ingest({
        claims: derived.claims,
        observations: derived.observations,
      })
      return {
        threadId,
        turnId,
        derived: derived.claims.length + derived.observations.length,
        recorded: ingested.claims.length + ingested.observations.length,
        error: undefined,
      }
    } catch (error) {
      return {
        threadId,
        turnId,
        derived: 0,
        recorded: 0,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The remembering wrapper
// ---------------------------------------------------------------------------

/** The turn-driving surface every AgentLoop service satisfies. */
export interface AgentLoopPort {
  runTurn(input: AgentLoopRunInput): Promise<AgentLoopTurnResult>
  recoverTurn(input: AgentLoopRecoverInput): Promise<AgentLoopTurnResult>
  resumeTurn(input: AgentLoopResumeInput): Promise<AgentLoopTurnResult>
}

/**
 * Wraps an AgentLoop service so every completed Turn feeds the derivation
 * worker before the caller sees the result. Suspended, failed, and cancelled
 * Turns derive nothing; their lease handling stays entirely with the inner
 * loop.
 */
export class RememberingAgentLoop implements AgentLoopPort {
  readonly #inner: AgentLoopPort & { stop?(): void }
  readonly #worker: MemoryDerivationWorker

  constructor(
    inner: AgentLoopPort & { stop?(): void },
    worker: MemoryDerivationWorker,
  ) {
    this.#inner = inner
    this.#worker = worker
  }

  async runTurn(input: AgentLoopRunInput): Promise<AgentLoopTurnResult> {
    const result = await this.#inner.runTurn(input)
    await this.#deriveIfCompleted(result)
    return result
  }

  async recoverTurn(
    input: AgentLoopRecoverInput,
  ): Promise<AgentLoopTurnResult> {
    const result = await this.#inner.recoverTurn(input)
    await this.#deriveIfCompleted(result)
    return result
  }

  async resumeTurn(input: AgentLoopResumeInput): Promise<AgentLoopTurnResult> {
    const result = await this.#inner.resumeTurn(input)
    await this.#deriveIfCompleted(result)
    return result
  }

  stop(): void {
    this.#inner.stop?.()
  }

  async #deriveIfCompleted(result: AgentLoopTurnResult): Promise<void> {
    if (result.status !== 'completed') return
    await this.#worker.afterTurn({
      threadId: result.turn.threadId,
      turnId: result.turn.id,
    })
  }
}
