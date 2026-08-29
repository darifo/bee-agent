import { createHash } from 'node:crypto'
import { canonicalJson } from '@bee-agent/kernel'
import {
  DEFAULT_TOOL_RESULT_COMPACTION,
  elisionsToOmissions,
  estimateMessageTokens,
  projectHistory,
} from './context-policy.ts'
import type { ToolResultCompactionPolicy } from './context-policy.ts'
import { SystemPromptAssembler } from './system-prompt.ts'
import { isLlmRuntimeError } from './llm-runtime.ts'
import type {
  LlmMessage,
  LlmStreamEvent,
  LlmToolCall,
  LlmToolSpec,
} from './llm-runtime.ts'
import type { ModelRequestService } from './model-request-service.ts'
import type { ActionResult } from '@bee-agent/execution'
import type {
  ToolExecutionOutcome,
  ToolExecutionPort,
  ToolConcurrency,
} from './tool-execution.ts'
import {
  agentCheckpointEvent,
  agentRecoveryFailedEvent,
  appendThreadEvents,
  contextCompactedEvent,
  itemCompletedEvent,
  itemDeltaEvent,
  itemFailedEvent,
  itemStartedEvent,
  newItem,
  newTurn,
  readThreadEvents,
  turnCancelledEvent,
  turnCompletedEvent,
  turnFailedEvent,
  turnStartedEvent,
} from '@bee-agent/thread'
import type {
  Item,
  ThreadId,
  ThreadEvent,
  Turn,
  TurnId,
} from '@bee-agent/thread'
import type { ChronicleStore, NewChronicleEvent } from '@bee-agent/knowledge'

/**
 * The AgentLoop minimal core (architecture §10.1/§10.2, v1 refactor plan
 * §5.2 P1-11): Act and Record first, with retrieval and planning left as
 * hook seams for Phase 2. The loop owns all message state — the LLMRuntime
 * is stateless — and every effect is appended to the thread's Chronicle
 * stream, so a crashed turn resumes from Chronicle plus the last checkpoint
 * (see {@link AgentLoop.recoverTurn}).
 */

// ---------------------------------------------------------------------------
// Phase 2 hook seams (retrieval, planning)
// ---------------------------------------------------------------------------

/** What a loop can take its system message from. */
export type SystemPromptSource =
  string | (() => string | Promise<string>) | SystemPromptAssembler

export interface AgentLoopHookInput {
  readonly threadId: ThreadId
  readonly turnId: TurnId
  readonly input: string
  readonly history: readonly LlmMessage[]
  readonly stepIndex: number
}

export interface AgentLoopRetrieveHook {
  retrieve(input: AgentLoopHookInput): Promise<readonly LlmMessage[]>
}

export interface AgentLoopPlanHook {
  plan(input: AgentLoopHookInput): Promise<readonly LlmMessage[]>
}

// ---------------------------------------------------------------------------
// Configuration and results
// ---------------------------------------------------------------------------

export interface AgentLoopOptions {
  readonly modelRequests: ModelRequestService
  readonly store: ChronicleStore
  readonly toolExecution: ToolExecutionPort
  /** Tool declarations passed to the model; empty until tool specs land. */
  readonly toolSpecs?: readonly LlmToolSpec[] | undefined
  readonly hooks?:
    | {
        readonly retrieve?: AgentLoopRetrieveHook | undefined
        readonly plan?: AgentLoopPlanHook | undefined
      }
    | undefined
  readonly maxSteps?: number | undefined
  readonly maxRetries?: number | undefined
  /**
   * System message prepended to every model-visible request. Resolved once
   * (memoized) so the prefix stays byte-stable for provider caching;
   * dynamic context belongs in the retrieve/plan hooks instead. A plain
   * string, a lazy provider, or a budgeted
   * {@link SystemPromptAssembler}.
   */
  readonly systemPrompt?: SystemPromptSource | undefined
  /**
   * Context policy for the model-visible projection of history: old tool
   * results beyond the budget are elided (protected: errors and the recent
   * window). Defaults to {@link DEFAULT_TOOL_RESULT_COMPACTION}.
   */
  readonly toolResultCompaction?:
    | {
        readonly toolResultBudgetTokens?: number | undefined
        readonly keepRecentToolResults?: number | undefined
      }
    | undefined
  /**
   * Level-2 compaction: when the model-visible request exceeds the
   * threshold, the covered history prefix is summarized by a dedicated
   * model call and replaced — in the projection only — by a durable
   * `context.compacted` summary. Defaults on: threshold at 70% of the
   * model's context window, recent 12 messages kept verbatim, at most 2
   * summarization attempts per turn (the breaker that keeps a failing
   * summarizer from looping).
   */
  readonly contextCompaction?:
    | {
        readonly thresholdTokens?: number | undefined
        readonly keepRecentMessages?: number | undefined
        readonly maxAttemptsPerTurn?: number | undefined
        readonly minCoveredMessages?: number | undefined
      }
    | undefined
  /** Pass false to start each turn from its own input only (no carry). */
  readonly carryThreadHistory?: boolean | undefined
  /**
   * Upper bound on simultaneously in-flight parallel-safe tool calls per
   * batch; defaults to 8. Exclusive tools always run alone.
   */
  readonly maxParallelToolCalls?: number | undefined
  /**
   * Output-token cap for the first generation attempt. When the model hits
   * the limit, the cap doubles (bounded by the model's maximum) and the step
   * regenerates instead of failing the turn.
   */
  readonly maxOutputTokens?: number | undefined
  /**
   * Base delay for exponential backoff between retries; doubles per retry,
   * capped at 30s. Providers' Retry-After hints win when present.
   */
  readonly initialRetryDelayMs?: number | undefined
  /** Fixed retry delay override (tests); skips backoff and Retry-After. */
  readonly retryDelayMs?: number | undefined
  readonly now?: (() => string) | undefined
}

export interface AgentLoopRunInput {
  readonly threadId: ThreadId
  readonly input: string
  /** What started the turn; user-facing requests default to `user`. */
  readonly trigger?: 'user' | 'system' | 'schedule' | undefined
  readonly structureVersion?: string | undefined
  readonly signal?: AbortSignal | undefined
}

export interface AgentLoopRecoverInput {
  readonly threadId: ThreadId
  readonly turnId: TurnId
  readonly signal?: AbortSignal | undefined
}

export interface AgentLoopResumeInput {
  readonly threadId: ThreadId
  readonly turnId: TurnId
  readonly approvalId: string
  readonly decision: 'approved' | 'rejected'
  readonly signal?: AbortSignal | undefined
}

export type AgentLoopTurnResult =
  | {
      readonly status: 'completed'
      readonly output: string
      readonly turn: Turn
    }
  | { readonly status: 'failed'; readonly error: string; readonly turn: Turn }
  | { readonly status: 'cancelled'; readonly turn: Turn }
  | {
      readonly status: 'suspended'
      readonly approval: { readonly approvalId: string; readonly title: string }
      readonly turn: Turn
    }

// ---------------------------------------------------------------------------

interface LoopState {
  readonly turn: Turn
  readonly history: LlmMessage[]
  stepIndex: number
  /** Newest valid conversation summary; undefined until the first compaction. */
  compaction: CompactionView | undefined
  /** Level-2 compaction attempts this turn; the breaker caps them. */
  compactionAttempts: number
}

/** The durable compaction a projection folds the history prefix into. */
interface CompactionView {
  readonly summary: string
  readonly coveredMessageCount: number
  readonly coveredDigest: string
}

type ToolCallItem = Extract<Item, { type: 'tool_call' }>
type ApprovalItem = Extract<Item, { type: 'approval' }>

interface GenerationIntent {
  readonly call: LlmToolCall
  readonly item: ToolCallItem
}

/** One dispatched intent: its history message, or a terminal turn result. */
type IntentOutcome =
  { readonly message: LlmMessage } | { readonly terminal: AgentLoopTurnResult }

/** The compacted prefix as one message the model reads as prior context. */
function summaryMessage(compaction: CompactionView): LlmMessage {
  return {
    role: 'user',
    content: `Summary of the earlier conversation (${compaction.coveredMessageCount} messages):\n\n${compaction.summary}`,
  }
}

/** Drains a call's message-delta events to their concatenated text. */
async function collectStreamText(
  events: AsyncIterable<LlmStreamEvent>,
): Promise<string> {
  let text = ''
  for await (const event of events) {
    if (event.kind === 'message-delta') text += event.delta
  }
  return text
}

interface GenerationOutcome {
  readonly stopReason: 'end_turn' | 'decision' | 'max_tokens' | 'tool_calls'
  readonly assistantMessage: LlmMessage
  /** The assistant item in its completed form; #drive records it. */
  readonly assistantItem: Item
  readonly intents: readonly GenerationIntent[]
  readonly output: string
}

type GenerationResult =
  | { readonly ok: true; readonly outcome: GenerationOutcome }
  | {
      readonly ok: false
      readonly reason: 'failed' | 'cancelled'
      readonly error?: string
    }

interface PendingApproval {
  readonly approvalId: string
  readonly title: string
  readonly call: LlmToolCall
  readonly toolItem: ToolCallItem
  readonly approvalItem: ApprovalItem
}

interface RebuiltState {
  readonly state: LoopState
  readonly pendingApproval: PendingApproval | undefined
}

type TurnScopedEvent = Extract<ThreadEvent, { turnId: string }>

export class CheckpointDigestMismatchError extends Error {
  constructor(
    readonly checkpointSequence: number,
    readonly expectedDigest: string,
    readonly actualDigest: string,
  ) {
    super(
      `Checkpoint ${checkpointSequence} rebuilt to ${actualDigest}, expected ${expectedDigest}`,
    )
    this.name = 'CheckpointDigestMismatchError'
  }
}

export class AgentLoop {
  readonly #options: AgentLoopOptions

  constructor(options: AgentLoopOptions) {
    this.#options = options
  }

  // -----------------------------------------------------------------------
  // Public entry points
  // -----------------------------------------------------------------------

  async runTurn(input: AgentLoopRunInput): Promise<AgentLoopTurnResult> {
    const now = this.#now()
    const turn = newTurn({
      threadId: input.threadId,
      trigger: input.trigger ?? 'user',
      input: input.input,
      structureVersion: input.structureVersion,
      now,
    })
    await this.#append(input.threadId, turnStartedEvent(turn))

    // Conversation continuity: this thread's prior turns — their completed
    // messages and tool calls, in sequence order — precede the new input,
    // so a thread behaves like one conversation instead of isolated turns.
    // The same read loads any durable conversation summary (level-2
    // compaction) whose covered prefix still matches.
    const threadPage =
      this.#options.carryThreadHistory === false
        ? undefined
        : await readThreadEvents(this.#options.store, input.threadId)
    const carried = threadPage
      ? this.#messagesFromEvents(threadPage.events)
      : []

    const userItem = newItem({
      threadId: input.threadId,
      turnId: turn.id,
      type: 'message',
      payload: { role: 'user', content: input.input },
      now,
    })
    await this.#append(
      input.threadId,
      itemStartedEvent(userItem),
      itemCompletedEvent(userItem),
    )

    return this.#drive(
      {
        turn,
        history: [...carried, { role: 'user', content: input.input }],
        stepIndex: 0,
        compaction: this.#loadCompaction(threadPage?.events ?? [], carried),
        compactionAttempts: 0,
      },
      input.signal,
    )
  }

  /**
   * Maps completed items, in event order, to their LlmMessage form — the
   * one reconstruction both turn recovery and thread carry use.
   */
  #messagesFromEvents(events: readonly ThreadEvent[]): LlmMessage[] {
    const messages: LlmMessage[] = []
    for (const event of events) {
      if (event.event !== 'item.completed') continue
      const item = event.item
      if (item.type === 'message') {
        if (item.payload.role === 'user' || item.payload.role === 'system') {
          messages.push({
            role: item.payload.role,
            content: item.payload.content,
          })
        } else if (item.payload.role === 'assistant') {
          messages.push({
            role: 'assistant',
            content: item.payload.content,
            ...(item.payload.toolCalls === undefined
              ? {}
              : { toolCalls: item.payload.toolCalls }),
          })
        }
      } else if (item.type === 'tool_call') {
        const output = item.payload.output
        messages.push({
          role: 'tool',
          callId: item.payload.callId,
          toolId: item.payload.toolId,
          content:
            item.payload.content ??
            (typeof output === 'string' ? output : JSON.stringify(output)),
          ...(item.payload.isError === undefined
            ? {}
            : { isError: item.payload.isError }),
        })
      }
    }
    return messages
  }

  /**
   * Loads the newest compaction whose covered digest still matches the
   * thread's history prefix — the durable summary crash recovery resumes
   * from. Digest mismatch (a history the summary does not describe) makes
   * the event inapplicable rather than wrong.
   */
  #loadCompaction(
    events: readonly ThreadEvent[],
    history: readonly LlmMessage[],
  ): CompactionView | undefined {
    let view: CompactionView | undefined
    for (const event of events) {
      if (event.event !== 'context.compacted') continue
      if (!this.#compactionApplies(event, history)) continue
      view = {
        summary: event.summary,
        coveredMessageCount: event.coveredMessageCount,
        coveredDigest: event.coveredDigest,
      }
    }
    return view
  }

  #compactionApplies(
    event: Extract<ThreadEvent, { event: 'context.compacted' }>,
    history: readonly LlmMessage[],
  ): boolean {
    if (event.coveredMessageCount > history.length) return false
    const covered = history.slice(0, event.coveredMessageCount)
    return this.#digest(covered) === event.coveredDigest
  }

  async recoverTurn(
    input: AgentLoopRecoverInput,
  ): Promise<AgentLoopTurnResult> {
    const rebuilt = await this.#rebuild(input.threadId, input.turnId)
    if (rebuilt.pendingApproval !== undefined) {
      throw new Error(
        `Turn '${input.turnId}' is suspended awaiting approval '${rebuilt.pendingApproval.approvalId}'; use resumeTurn instead`,
      )
    }
    if (rebuilt.state.turn.status !== 'active') {
      throw new Error(
        `Turn '${input.turnId}' is '${rebuilt.state.turn.status}', not recoverable`,
      )
    }
    return this.#drive(rebuilt.state, input.signal)
  }

  async resumeTurn(input: AgentLoopResumeInput): Promise<AgentLoopTurnResult> {
    const rebuilt = await this.#rebuild(input.threadId, input.turnId)
    const pending = rebuilt.pendingApproval
    if (pending === undefined) {
      throw new Error(`Turn '${input.turnId}' has no pending approval`)
    }
    if (pending.approvalId !== input.approvalId) {
      throw new Error(
        `Approval '${input.approvalId}' does not match pending approval '${pending.approvalId}'`,
      )
    }

    const now = this.#now()
    await this.#append(
      input.threadId,
      itemCompletedEvent({
        ...pending.approvalItem,
        status: 'completed',
        endedAt: now,
        payload: { ...pending.approvalItem.payload, status: input.decision },
      }),
    )

    let outcome: ToolExecutionOutcome
    try {
      outcome = await this.#options.toolExecution.execute({
        call: pending.call,
        threadId: input.threadId,
        turnId: input.turnId,
        itemId: pending.toolItem.id,
        structureVersion: rebuilt.state.turn.structureVersion,
        approval: input.decision,
        signal: input.signal,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Same isolation as the live loop: a failed tool is an error result the
      // model reacts to, not a turn failure.
      rebuilt.state.history.push(
        await this.#errorToolItem(
          input.threadId,
          pending.toolItem,
          `Tool execution failed: ${message}`,
          now,
        ),
      )
      return this.#drive(rebuilt.state, input.signal)
    }
    if (outcome.kind === 'approval-required') {
      throw new Error('ExecutionWorld requested approval after a decision')
    }
    const toolMessage = await this.#completeToolItem(
      input.threadId,
      pending.toolItem,
      outcome.result,
      now,
    )
    rebuilt.state.history.push(toolMessage)

    return this.#drive(rebuilt.state, input.signal)
  }

  // -----------------------------------------------------------------------
  // Step loop: Act (generate + tools) → Record (checkpoint) → decide
  // -----------------------------------------------------------------------

  async #drive(
    state: LoopState,
    signal: AbortSignal | undefined,
  ): Promise<AgentLoopTurnResult> {
    const maxSteps = this.#options.maxSteps ?? 8
    const maxRetries = this.#options.maxRetries ?? 2
    const modelMaxOutputTokens =
      this.#options.modelRequests.capabilities().maxOutputTokens
    let outputTokenCap = Math.min(
      this.#options.maxOutputTokens ?? modelMaxOutputTokens,
      modelMaxOutputTokens,
    )

    while (true) {
      if (signal?.aborted) return this.#cancel(state)

      if (state.stepIndex >= maxSteps) {
        return this.#fail(state, `Exceeded the maximum of ${maxSteps} steps`)
      }

      // A resumed or crash-recovered step may still carry unexecuted tool
      // calls from its last assistant message; finish them (idempotency
      // keys make re-dispatch safe) before generating anything new.
      const unanswered = this.#unansweredIntents(state)
      if (unanswered.length > 0) {
        const terminal = await this.#runIntents(state, unanswered, signal)
        if (terminal !== undefined) return terminal
        const settled = state.stepIndex + 1
        await this.#checkpoint(
          state.turn.threadId,
          state.turn.id,
          settled,
          state.history,
        )
        state.stepIndex = settled
      }

      const generated = await this.#generate(
        state,
        signal,
        maxRetries,
        outputTokenCap,
      )
      if (!generated.ok) {
        if (signal?.aborted) return this.#cancel(state)
        return this.#fail(state, generated.error ?? 'Generation failed')
      }
      const outcome = generated.outcome

      if (outcome.stopReason === 'max_tokens') {
        // Escalate the output cap and regenerate the step; the truncated
        // attempt is recorded as a failed item and never enters history, so
        // the checkpoint digest stays rebuildable.
        const escalated = Math.min(outputTokenCap * 2, modelMaxOutputTokens)
        if (escalated > outputTokenCap) {
          await this.#append(
            state.turn.threadId,
            itemFailedEvent(
              {
                threadId: state.turn.threadId,
                turnId: state.turn.id,
                itemId: outcome.assistantItem.id,
              },
              `Output token limit reached at ${outputTokenCap} tokens; retrying with ${escalated}`,
            ),
          )
          outputTokenCap = escalated
          continue
        }
        await this.#append(
          state.turn.threadId,
          itemFailedEvent(
            {
              threadId: state.turn.threadId,
              turnId: state.turn.id,
              itemId: outcome.assistantItem.id,
            },
            'Model hit the output token limit',
          ),
        )
        return this.#fail(
          state,
          `Model hit the output token limit (${outputTokenCap} tokens, the model maximum)`,
        )
      }

      // Act: record the assistant message, then run its tool intents.
      await this.#append(
        state.turn.threadId,
        itemCompletedEvent(outcome.assistantItem),
      )
      state.history.push(outcome.assistantMessage)
      const terminal = await this.#runIntents(state, outcome.intents, signal)
      if (terminal !== undefined) return terminal

      const nextStepIndex = state.stepIndex + 1

      // Record: checkpoint after every durable step, before the next call.
      await this.#checkpoint(
        state.turn.threadId,
        state.turn.id,
        nextStepIndex,
        state.history,
      )

      if (
        outcome.stopReason === 'end_turn' ||
        outcome.stopReason === 'decision'
      ) {
        return this.#complete(state, outcome)
      }
      // tool_calls: loop again with the recorded results.
      state.stepIndex = nextStepIndex
    }
  }

  // -----------------------------------------------------------------------
  // Tool intents: segmented dispatch (parallel-safe batches, ordered commit)
  // -----------------------------------------------------------------------

  /**
   * Runs one generation's tool intents. Consecutive parallel-safe calls run
   * as a bounded concurrent batch; exclusive calls (the default) and batch
   * boundaries run strictly in order. Results always enter history in model
   * order regardless of completion order, keeping call/output pairing intact.
   * Returns a terminal turn result on suspend/cancel, or undefined when
   * every intent settled.
   */
  async #runIntents(
    state: LoopState,
    intents: readonly GenerationIntent[],
    signal: AbortSignal | undefined,
  ): Promise<AgentLoopTurnResult | undefined> {
    const maxParallel = this.#options.maxParallelToolCalls ?? 8
    for (const segment of this.#segmentIntents(intents)) {
      if (signal?.aborted) return this.#cancel(state)
      if (segment.concurrency === 'exclusive') {
        for (const intent of segment.intents) {
          if (signal?.aborted) return this.#cancel(state)
          const outcome = await this.#dispatchIntent(state, intent, signal)
          if ('terminal' in outcome) return outcome.terminal
          state.history.push(outcome.message)
        }
        continue
      }
      for (
        let offset = 0;
        offset < segment.intents.length;
        offset += maxParallel
      ) {
        if (signal?.aborted) return this.#cancel(state)
        const batch = segment.intents.slice(offset, offset + maxParallel)
        // allSettled: an infrastructure failure (Chronicle write) must not
        // leave sibling rejections unhandled.
        const settled = await Promise.allSettled(
          batch.map((intent) => this.#dispatchIntent(state, intent, signal)),
        )
        const outcomes: IntentOutcome[] = []
        for (const result of settled) {
          if (result.status === 'rejected') {
            throw new Error(
              `Tool dispatch failed: ${
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason)
              }`,
            )
          }
          outcomes.push(result.value)
        }
        // Commit in model order after the whole batch settles, so a
        // suspension checkpoints the same history a rebuild would produce.
        let terminal: AgentLoopTurnResult | undefined
        for (const outcome of outcomes) {
          if ('terminal' in outcome) {
            terminal = terminal ?? outcome.terminal
            continue
          }
          state.history.push(outcome.message)
        }
        if (terminal !== undefined) return terminal
      }
    }
    return undefined
  }

  /** Groups consecutive intents with the same concurrency class. */
  #segmentIntents(intents: readonly GenerationIntent[]): readonly {
    readonly concurrency: ToolConcurrency
    readonly intents: readonly GenerationIntent[]
  }[] {
    const segments: {
      concurrency: ToolConcurrency
      intents: GenerationIntent[]
    }[] = []
    for (const intent of intents) {
      const concurrency =
        intent.call.inputError !== undefined
          ? 'exclusive'
          : (this.#options.toolExecution.concurrency?.(intent.call) ??
            'exclusive')
      const last = segments.at(-1)
      if (last !== undefined && last.concurrency === concurrency) {
        last.intents.push(intent)
      } else {
        segments.push({ concurrency, intents: [intent] })
      }
    }
    return segments
  }

  /** Dispatches one intent: executes (or short-circuits) and records it. */
  async #dispatchIntent(
    state: LoopState,
    intent: GenerationIntent,
    signal: AbortSignal | undefined,
  ): Promise<IntentOutcome> {
    // A tool failure is a result the model reacts to, not a turn error: the
    // error becomes an `isError` tool message in history and the loop
    // continues. item.completed (not item.failed) keeps the checkpoint
    // digest rebuildable from Chronicle.
    if (intent.call.inputError !== undefined) {
      return {
        message: await this.#errorToolItem(
          state.turn.threadId,
          intent.item,
          intent.call.inputError,
          this.#now(),
        ),
      }
    }
    let result: ToolExecutionOutcome
    try {
      result = await this.#options.toolExecution.execute({
        call: intent.call,
        threadId: state.turn.threadId,
        turnId: state.turn.id,
        itemId: intent.item.id,
        structureVersion: state.turn.structureVersion,
        signal,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        message: await this.#errorToolItem(
          state.turn.threadId,
          intent.item,
          `Tool execution failed: ${message}`,
          this.#now(),
        ),
      }
    }
    if (result.kind === 'approval-required') {
      return { terminal: await this.#suspend(state, intent, result) }
    }
    return {
      message: await this.#completeToolItem(
        state.turn.threadId,
        intent.item,
        result.result,
        this.#now(),
      ),
    }
  }

  /**
   * Tool calls of the last assistant message that have no tool result in
   * history — the leftovers of a suspended or crashed step, rebuilt as
   * fresh intents for re-dispatch.
   */
  #unansweredIntents(state: LoopState): readonly GenerationIntent[] {
    const lastAssistant = [...state.history]
      .reverse()
      .find(
        (message): message is Extract<LlmMessage, { role: 'assistant' }> =>
          message.role === 'assistant' &&
          message.toolCalls !== undefined &&
          message.toolCalls.length > 0,
      )
    if (lastAssistant === undefined) return []
    const answered = new Set(
      state.history
        .filter(
          (message): message is Extract<LlmMessage, { role: 'tool' }> =>
            message.role === 'tool',
        )
        .map((message) => message.callId),
    )
    const unanswered = lastAssistant.toolCalls?.filter(
      (call) => !answered.has(call.callId),
    )
    if (unanswered === undefined || unanswered.length === 0) return []
    const now = this.#now()
    return unanswered.map((call) => ({
      call,
      item: newItem({
        threadId: state.turn.threadId,
        turnId: state.turn.id,
        type: 'tool_call',
        payload: {
          toolId: call.toolId,
          callId: call.callId,
          input: call.input,
          ...(call.inputError === undefined
            ? {}
            : { inputError: call.inputError }),
        },
        now,
      }),
    }))
  }

  // -----------------------------------------------------------------------
  // Act: one generation with retry classification and provider backoff
  // -----------------------------------------------------------------------

  /** Summarization prompt for the covered prefix; a utility call, no tools. */
  static readonly #COMPACTION_PROMPT = [
    'Summarize the conversation so far for another instance of yourself that',
    'will continue it without seeing the original messages.',
    'Keep: the user’s goal and stated preferences, decisions taken, tool',
    'actions and their outcomes (including failures), and any open thread.',
    'Drop: pleasantries, verbatim transcripts, and redundant detail.',
    'Write dense prose or bullets, under 400 words. Output only the summary.',
  ].join(' ')

  #compactionThresholdTokens(): number {
    const configured = this.#options.contextCompaction?.thresholdTokens
    if (configured !== undefined) return configured
    const window = this.#options.modelRequests.capabilities().maxContextTokens
    return Math.floor(window * 0.7)
  }

  /**
   * Level-2 compaction: over threshold, summarize the covered prefix of the
   * FULL history once per trigger and record a durable `context.compacted`
   * event. Attempts are capped per turn (the breaker): a failing summarizer
   * must not loop — the generation proceeds with the unfolded view and the
   * provider surfaces any overflow honestly.
   */
  async #maybeCompact(
    state: LoopState,
    system: LlmMessage | undefined,
    retrieved: readonly LlmMessage[] | undefined,
    planned: readonly LlmMessage[] | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const policy = {
      threshold: this.#compactionThresholdTokens(),
      keepRecent: this.#options.contextCompaction?.keepRecentMessages ?? 12,
      maxAttempts: this.#options.contextCompaction?.maxAttemptsPerTurn ?? 2,
      minCovered: this.#options.contextCompaction?.minCoveredMessages ?? 2,
    }
    if (state.compactionAttempts >= policy.maxAttempts) return

    const view = this.#compactView(state.history, state.compaction)
    const assembled: LlmMessage[] = [
      ...(system === undefined ? [] : [system]),
      ...view,
      ...(retrieved ?? []),
      ...(planned ?? []),
    ]
    const estimate = this.#estimateTokens(
      projectHistory(assembled, this.#compactionPolicy()).messages,
    )
    if (estimate <= policy.threshold) return

    // The next covered span: everything the current summary already covers,
    // plus full-history messages up to the recent window. Compacting the
    // full history (not the folded view) keeps one summary authoritative.
    const alreadyCovered = state.compaction?.coveredMessageCount ?? 0
    const coveredCount = Math.max(
      alreadyCovered,
      state.history.length - policy.keepRecent,
    )
    if (coveredCount <= alreadyCovered) return
    if (coveredCount < policy.minCovered) return
    const covered = state.history.slice(0, coveredCount)

    state.compactionAttempts += 1
    const summary = await this.#summarize(state, covered, signal)
    if (summary === undefined) return
    state.compaction = {
      summary,
      coveredMessageCount: coveredCount,
      coveredDigest: this.#digest(covered),
    }
    await this.#append(
      state.turn.threadId,
      contextCompactedEvent(
        { threadId: state.turn.threadId, turnId: state.turn.id },
        {
          summary,
          coveredMessageCount: coveredCount,
          coveredDigest: state.compaction.coveredDigest,
          coveredTokens: this.#estimateTokens(covered),
        },
      ),
    )
  }

  /** One durable, tool-free summarization call; undefined on failure. */
  async #summarize(
    state: LoopState,
    covered: readonly LlmMessage[],
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    const transcript = covered
      .map((message) => {
        if (message.role === 'tool') {
          return `[tool ${message.toolId} (${message.callId})] ${message.content}`
        }
        const calls =
          message.role === 'assistant' && message.toolCalls !== undefined
            ? ` ${JSON.stringify(message.toolCalls)}`
            : ''
        return `[${message.role}] ${message.content}${calls}`
      })
      .join('\n')
    try {
      const call = await this.#options.modelRequests.generate({
        threadId: state.turn.threadId,
        turnId: state.turn.id,
        stepIndex: state.stepIndex,
        attempt: 0,
        structureVersion: state.turn.structureVersion,
        bundle: {
          messages: [
            { role: 'system', content: AgentLoop.#COMPACTION_PROMPT },
            { role: 'user', content: transcript },
          ],
          tools: [],
        },
        options: { signal },
      })
      const result = await call.result
      if (result.stopReason === 'cancelled') return undefined
      const summary = (await collectStreamText(call.events)).trim()
      return summary.length > 0 ? summary : undefined
    } catch {
      // The breaker already counted the attempt; proceed unfolded.
      return undefined
    }
  }

  /** The model-visible history: covered prefix folded into the summary. */
  #compactView(
    history: readonly LlmMessage[],
    compaction: CompactionView | undefined,
  ): readonly LlmMessage[] {
    if (compaction === undefined) return history
    const covered = history.slice(0, compaction.coveredMessageCount)
    if (this.#digest(covered) !== compaction.coveredDigest) return history
    if (compaction.coveredMessageCount >= history.length) {
      // Everything is covered; the summary is the whole view.
      return [summaryMessage(compaction)]
    }
    return [
      summaryMessage(compaction),
      ...history.slice(compaction.coveredMessageCount),
    ]
  }

  #estimateTokens(messages: readonly LlmMessage[]): number {
    return messages.reduce(
      (total, message) => total + estimateMessageTokens(canonicalJson(message)),
      0,
    )
  }

  async #generate(
    state: LoopState,
    signal: AbortSignal | undefined,
    maxRetries: number,
    outputTokenCap: number,
  ): Promise<GenerationResult> {
    const hookInput: AgentLoopHookInput = {
      threadId: state.turn.threadId,
      turnId: state.turn.id,
      input: state.turn.input ?? '',
      history: state.history,
      stepIndex: state.stepIndex,
    }
    const retrieved = await this.#options.hooks?.retrieve?.retrieve(hookInput)
    const planned = await this.#options.hooks?.plan?.plan(hookInput)

    // Context policy: project the assembled history under the tool-result
    // budget. `state.history` keeps full fidelity; only what the model sees
    // is folded, deterministically, on every generation.
    // The system message is prepended after resolution and never varies
    // between generations — the cacheable prefix everything else builds on.
    const system = await this.#systemMessage()
    // Level 2: when the request still exceeds the compaction threshold,
    // summarize the covered history prefix once and fold it into the view.
    await this.#maybeCompact(state, system, retrieved, planned, signal)
    const visibleHistory = this.#compactView(state.history, state.compaction)
    const assembled: LlmMessage[] = [
      ...(system === undefined ? [] : [system]),
      ...visibleHistory,
      ...(retrieved ?? []),
      ...(planned ?? []),
    ]
    const projected = projectHistory(assembled, this.#compactionPolicy())
    const messages: LlmMessage[] = [...projected.messages]
    const elisions = elisionsToOmissions(projected.elisions)

    let lastError: unknown
    for (let retry = 0; retry <= maxRetries; retry += 1) {
      if (retry > 0) {
        const delay = this.#retryDelayMs(retry, lastError)
        if (delay > 0) await this.#sleep(delay, signal)
        if (signal?.aborted) return { ok: false, reason: 'cancelled' }
      }
      try {
        return await this.#attempt(
          state,
          messages,
          elisions,
          signal,
          retry,
          outputTokenCap,
        )
      } catch (error) {
        lastError = error
        if (signal?.aborted) return { ok: false, reason: 'cancelled' }
        if (
          isLlmRuntimeError(error) &&
          error.retryability === 'retryable' &&
          retry < maxRetries
        ) {
          continue
        }
        // Retries exhausted, or an unexpected throw: fail the turn rather
        // than crash the loop.
        return {
          ok: false,
          reason: 'failed',
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }
    return {
      ok: false,
      reason: 'failed',
      error: lastError instanceof Error ? lastError.message : String(lastError),
    }
  }

  /** Retry-After wins, then fixed override, then exponential backoff. */
  #retryDelayMs(retry: number, error: unknown): number {
    if (this.#options.retryDelayMs !== undefined)
      return this.#options.retryDelayMs
    if (
      isLlmRuntimeError(error) &&
      typeof error.retryAfterMs === 'number' &&
      error.retryAfterMs > 0
    ) {
      return error.retryAfterMs
    }
    const initial = this.#options.initialRetryDelayMs ?? 250
    return Math.min(initial * 2 ** (retry - 1), 30_000)
  }

  #compactionPolicy(): ToolResultCompactionPolicy {
    const overrides = this.#options.toolResultCompaction
    return {
      toolResultBudgetTokens:
        overrides?.toolResultBudgetTokens ??
        DEFAULT_TOOL_RESULT_COMPACTION.toolResultBudgetTokens,
      keepRecentToolResults:
        overrides?.keepRecentToolResults ??
        DEFAULT_TOOL_RESULT_COMPACTION.keepRecentToolResults,
    }
  }

  async #sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })
  }

  async #attempt(
    state: LoopState,
    messages: readonly LlmMessage[],
    elisions: readonly { sourceId: string; reason: string }[],
    signal: AbortSignal | undefined,
    attempt: number,
    outputTokenCap: number,
  ): Promise<GenerationResult> {
    if (signal?.aborted) return { ok: false, reason: 'cancelled' }

    const threadId = state.turn.threadId
    const turnId = state.turn.id
    const assistantItem = newItem({
      threadId,
      turnId,
      type: 'message',
      payload: { role: 'assistant', content: '' },
      now: this.#now(),
    })
    await this.#append(threadId, itemStartedEvent(assistantItem))

    const call = await this.#options.modelRequests.generate({
      threadId,
      turnId,
      stepIndex: state.stepIndex,
      attempt,
      structureVersion: state.turn.structureVersion,
      bundle: { messages: [...messages], tools: this.#options.toolSpecs ?? [] },
      ...(elisions.length === 0 ? {} : { elisions }),
      options: { signal, maxOutputTokens: outputTokenCap },
    })

    // Message deltas are buffered before hitting Chronicle: with a real
    // streaming provider a write per chunk would dominate turn latency.
    const DELTA_FLUSH_CHARS = 256
    const deltas: string[] = []
    let buffered = ''
    const intents: GenerationIntent[] = []
    let decision: unknown

    for await (const event of call.events) {
      if (signal?.aborted) {
        await this.#append(
          threadId,
          itemFailedEvent(
            { threadId, turnId, itemId: assistantItem.id },
            'cancelled',
          ),
        )
        return { ok: false, reason: 'cancelled' }
      }
      if (event.kind === 'message-delta') {
        deltas.push(event.delta)
        buffered += event.delta
        if (buffered.length >= DELTA_FLUSH_CHARS) {
          await this.#append(
            threadId,
            itemDeltaEvent(
              { threadId, turnId, itemId: assistantItem.id },
              buffered,
            ),
          )
          buffered = ''
        }
      } else if (event.kind === 'tool-intent') {
        const toolItem = newItem({
          threadId,
          turnId,
          type: 'tool_call',
          payload: {
            toolId: event.call.toolId,
            callId: event.call.callId,
            input: event.call.input,
            ...(event.call.inputError === undefined
              ? {}
              : { inputError: event.call.inputError }),
          },
          now: this.#now(),
        })
        await this.#append(threadId, itemStartedEvent(toolItem))
        intents.push({ call: event.call, item: toolItem })
      } else {
        decision = event.decision
      }
    }
    if (buffered.length > 0) {
      await this.#append(
        threadId,
        itemDeltaEvent(
          { threadId, turnId, itemId: assistantItem.id },
          buffered,
        ),
      )
    }

    let result
    try {
      result = await call.result
    } catch (error) {
      await this.#append(
        threadId,
        itemFailedEvent(
          { threadId, turnId, itemId: assistantItem.id },
          error instanceof Error ? error.message : String(error),
        ),
      )
      if (signal?.aborted) return { ok: false, reason: 'cancelled' }
      if (isLlmRuntimeError(error) && error.retryability !== 'retryable') {
        return {
          ok: false,
          reason: 'failed',
          error:
            error.retryability === 'context-overflow'
              ? 'Model context overflow while generating'
              : error.message,
        }
      }
      throw error
    }

    if (result.stopReason === 'cancelled') {
      await this.#append(
        threadId,
        itemFailedEvent(
          { threadId, turnId, itemId: assistantItem.id },
          'cancelled',
        ),
      )
      return { ok: false, reason: 'cancelled' }
    }

    const content = deltas.join('')
    const completedItem: Item = {
      ...assistantItem,
      status: 'completed',
      endedAt: this.#now(),
      payload: {
        role: 'assistant',
        content,
        ...(intents.length > 0
          ? { toolCalls: intents.map((intent) => intent.call) }
          : {}),
      },
    }

    const assistantMessage: LlmMessage = {
      role: 'assistant',
      content,
      ...(intents.length > 0
        ? { toolCalls: intents.map((intent) => intent.call) }
        : {}),
    }

    return {
      ok: true,
      outcome: {
        stopReason: result.stopReason,
        assistantMessage,
        assistantItem: completedItem,
        intents,
        output: decision !== undefined ? JSON.stringify(decision) : content,
      },
    }
  }

  // -----------------------------------------------------------------------
  // Record / terminal transitions
  // -----------------------------------------------------------------------

  async #checkpoint(
    threadId: ThreadId,
    turnId: TurnId,
    stepIndex: number,
    history: readonly LlmMessage[],
  ): Promise<void> {
    await this.#append(
      threadId,
      agentCheckpointEvent(
        { threadId, turnId },
        { stepIndex, stateDigest: this.#digest(history) },
      ),
    )
  }

  async #complete(
    state: LoopState,
    outcome: GenerationOutcome,
  ): Promise<AgentLoopTurnResult> {
    const turn: Turn = {
      ...state.turn,
      status: 'completed',
      endedAt: this.#now(),
    }
    await this.#append(state.turn.threadId, turnCompletedEvent(turn))
    return { status: 'completed', output: outcome.output, turn }
  }

  async #fail(state: LoopState, error: string): Promise<AgentLoopTurnResult> {
    const turn: Turn = { ...state.turn, status: 'failed', endedAt: this.#now() }
    await this.#append(state.turn.threadId, turnFailedEvent(turn, error))
    return { status: 'failed', error, turn }
  }

  async #cancel(state: LoopState): Promise<AgentLoopTurnResult> {
    const turn: Turn = {
      ...state.turn,
      status: 'cancelled',
      endedAt: this.#now(),
    }
    await this.#append(state.turn.threadId, turnCancelledEvent(turn))
    return { status: 'cancelled', turn }
  }

  async #suspend(
    state: LoopState,
    intent: GenerationIntent,
    result: Extract<ToolExecutionOutcome, { kind: 'approval-required' }>,
  ): Promise<AgentLoopTurnResult> {
    const now = this.#now()
    const approvalItem = newItem({
      threadId: state.turn.threadId,
      turnId: state.turn.id,
      type: 'approval',
      payload: {
        title: result.title,
        detail: result.detail,
        status: 'pending',
        approvalId: result.approvalId,
        callId: intent.call.callId,
        toolId: intent.call.toolId,
      },
      now,
    })
    await this.#append(state.turn.threadId, itemStartedEvent(approvalItem))
    await this.#checkpoint(
      state.turn.threadId,
      state.turn.id,
      state.stepIndex + 1,
      state.history,
    )

    return {
      status: 'suspended',
      approval: { approvalId: result.approvalId, title: result.title },
      turn: state.turn,
    }
  }

  async #completeToolItem(
    threadId: ThreadId,
    toolItem: ToolCallItem,
    result: ActionResult,
    now: string,
  ): Promise<LlmMessage> {
    const completed: ToolCallItem = {
      ...toolItem,
      status: 'completed',
      endedAt: now,
      payload: {
        ...toolItem.payload,
        output: result.output,
        content: result.content,
        ...(result.isError === undefined ? {} : { isError: result.isError }),
      },
    }
    await this.#append(threadId, itemCompletedEvent(completed))
    return {
      role: 'tool',
      callId: completed.payload.callId,
      toolId: completed.payload.toolId,
      content: result.content,
      // Omitted when undefined: canonicalJson would otherwise emit an
      // `isError: undefined` token that is not valid JSON on replay.
      ...(result.isError === undefined ? {} : { isError: result.isError }),
    }
  }

  /**
   * Records a tool failure as a completed item with an error result — the
   * model sees it and can correct course on the next generation. Recorded
   * as item.completed (not item.failed) so the checkpoint digest rebuilds
   * from Chronicle exactly.
   */
  async #errorToolItem(
    threadId: ThreadId,
    toolItem: ToolCallItem,
    message: string,
    now: string,
  ): Promise<LlmMessage> {
    const errored: ToolCallItem = {
      ...toolItem,
      status: 'completed',
      endedAt: now,
      payload: {
        ...toolItem.payload,
        output: { error: message },
        content: message,
        isError: true,
      },
    }
    await this.#append(threadId, itemCompletedEvent(errored))
    return {
      role: 'tool',
      callId: errored.payload.callId,
      toolId: errored.payload.toolId,
      content: message,
      isError: true,
    }
  }

  // -----------------------------------------------------------------------
  // Recovery: rebuild the committed state from Chronicle + last checkpoint
  // -----------------------------------------------------------------------

  async #rebuild(threadId: ThreadId, turnId: TurnId): Promise<RebuiltState> {
    const page = await readThreadEvents(this.#options.store, threadId)
    const events = page.events.filter(
      (event): event is TurnScopedEvent =>
        'turnId' in event && event.turnId === turnId,
    )

    const turn = this.#findTurn(events)
    if (turn === undefined) {
      throw new Error(`Turn '${turnId}' not found in thread '${threadId}'`)
    }

    const checkpoints = events.filter(
      (event) => event.event === 'agent.checkpoint',
    )
    const last = checkpoints.at(-1)
    const stepIndex = last?.stepIndex ?? 0
    const commitSequence = last?.sequence ?? 0

    // Rebuild exactly what the live loop held: the carried thread prefix
    // (everything durably completed before this turn started) followed by
    // this turn's committed items. Matching the live construction is what
    // keeps the checkpoint digest verifiable across recovery.
    const startedSequence = page.events.find(
      (event) => event.event === 'turn.started' && event.turn.id === turnId,
    )?.sequence
    const carried =
      startedSequence === undefined
        ? []
        : this.#messagesFromEvents(
            page.events.filter((event) => event.sequence < startedSequence),
          )
    const history = [
      ...carried,
      ...this.#rebuildHistory(events, commitSequence),
    ]
    if (last !== undefined) {
      const actualDigest = this.#digest(history)
      if (actualDigest !== last.stateDigest) {
        await this.#append(
          threadId,
          agentRecoveryFailedEvent(
            { threadId, turnId },
            {
              checkpointSequence: last.sequence,
              expectedDigest: last.stateDigest,
              actualDigest,
            },
          ),
        )
        throw new CheckpointDigestMismatchError(
          last.sequence,
          last.stateDigest,
          actualDigest,
        )
      }
    }
    const pendingApproval = this.#findPendingApproval(events)

    return {
      state: {
        turn,
        history,
        stepIndex,
        compaction: this.#loadCompaction(page.events, history),
        compactionAttempts: 0,
      },
      pendingApproval,
    }
  }

  #rebuildHistory(
    events: readonly TurnScopedEvent[],
    commitSequence: number,
  ): LlmMessage[] {
    return this.#messagesFromEvents(
      events.filter((event) => event.sequence <= commitSequence),
    )
  }

  #findTurn(events: readonly TurnScopedEvent[]): Turn | undefined {
    // Prefer a terminal state if one exists; otherwise the started turn.
    let started: Turn | undefined
    let terminal: Turn | undefined
    for (const event of events) {
      if (event.event === 'turn.started') started = event.turn
      else if (
        event.event === 'turn.completed' ||
        event.event === 'turn.failed' ||
        event.event === 'turn.cancelled'
      ) {
        terminal = event.turn
      }
    }
    return terminal ?? started
  }

  #findPendingApproval(
    events: readonly TurnScopedEvent[],
  ): PendingApproval | undefined {
    const completed = new Set<string>()
    for (const event of events) {
      if (event.event === 'item.completed') completed.add(event.item.id)
    }

    const activeToolItems = new Map<string, ToolCallItem>()
    for (const event of events) {
      if (event.event !== 'item.started') continue
      if (event.item.type !== 'tool_call') continue
      if (completed.has(event.item.id)) continue
      activeToolItems.set(event.item.payload.callId, event.item)
    }

    for (const event of events) {
      if (event.event !== 'item.started') continue
      const item = event.item
      if (item.type !== 'approval') continue
      if (completed.has(item.id)) continue
      if (item.payload.status !== 'pending') continue
      if (item.payload.callId === undefined) continue
      const toolItem = activeToolItems.get(item.payload.callId)
      if (toolItem === undefined) continue
      return {
        approvalId: item.payload.approvalId ?? item.id,
        title: item.payload.title,
        call: {
          callId: toolItem.payload.callId,
          toolId: toolItem.payload.toolId,
          input: toolItem.payload.input,
        },
        toolItem,
        approvalItem: item,
      }
    }
    return undefined
  }

  // -----------------------------------------------------------------------
  // Utilities
  // -----------------------------------------------------------------------

  /** Memoized system message: resolved once, identical on every generation. */
  #systemMessageCached: LlmMessage | undefined
  #systemMessageResolved = false

  async #systemMessage(): Promise<LlmMessage | undefined> {
    if (this.#systemMessageResolved) return this.#systemMessageCached
    this.#systemMessageResolved = true
    const source = this.#options.systemPrompt
    if (source === undefined) return undefined
    const content =
      typeof source === 'string'
        ? source
        : source instanceof SystemPromptAssembler
          ? (await source.resolve()).content
          : await source()
    if (content.trim().length === 0) return undefined
    this.#systemMessageCached = { role: 'system', content }
    return this.#systemMessageCached
  }

  /** Serializes Chronicle writes: appendThreadEvents is not concurrent-safe
   * (it positions appends by reading the stream tail), and parallel tool
   * dispatch completes out of order. The queue keeps going after a failed
   * write; the failure surfaces to the awaiting caller. */
  #appendQueue: Promise<void> = Promise.resolve()

  async #append(
    threadId: ThreadId,
    ...events: readonly NewChronicleEvent[]
  ): Promise<void> {
    if (events.length === 0) return
    const write = this.#appendQueue.then(() =>
      appendThreadEvents(this.#options.store, threadId, events),
    )
    this.#appendQueue = write.then(
      () => {},
      () => {},
    )
    await write
  }

  #now(): string {
    return (this.#options.now ?? (() => new Date().toISOString()))()
  }

  #digest(history: readonly LlmMessage[]): string {
    return `sha256:${createHash('sha256')
      .update(canonicalJson(history))
      .digest('hex')}`
  }
}
