import { createHash } from 'node:crypto'
import { canonicalJson } from '@bee-agent/kernel'
import { isLlmRuntimeError } from './llm-runtime.ts'
import type {
  LlmMessage,
  LlmRuntime,
  LlmToolCall,
  LlmToolSpec,
} from './llm-runtime.ts'
import {
  agentCheckpointEvent,
  appendThreadEvents,
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
  ItemId,
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
// Execution slot (direct in Phase 1, ExecutionWorld in Phase 3)
// ---------------------------------------------------------------------------

export interface AgentLoopToolSlotCall {
  readonly call: LlmToolCall
  readonly threadId: ThreadId
  readonly turnId: TurnId
  /** The tool_call item this execution is bound to (for provenance links). */
  readonly itemId?: ItemId | undefined
  /** Present when a previously requested approval was granted or rejected. */
  readonly approval?: 'approved' | 'rejected' | undefined
  readonly signal?: AbortSignal | undefined
}

/** The execution seam tools run through; swapped for ExecutionWorld in Phase 3. */
export interface AgentLoopToolSlot {
  execute(input: AgentLoopToolSlotCall): Promise<AgentLoopToolOutcome>
}

export type AgentLoopToolOutcome =
  | {
      readonly kind: 'result'
      readonly output: unknown
      readonly content: string
      readonly isError?: boolean | undefined
    }
  | {
      readonly kind: 'approval-required'
      readonly approvalId: string
      readonly title: string
      readonly detail?: string | undefined
    }

// ---------------------------------------------------------------------------
// Phase 2 hook seams (retrieval, planning)
// ---------------------------------------------------------------------------

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
  readonly llm: LlmRuntime
  readonly store: ChronicleStore
  readonly tools: AgentLoopToolSlot
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
  readonly now?: (() => string) | undefined
}

export interface AgentLoopRunInput {
  readonly threadId: ThreadId
  readonly input: string
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
}

type ToolCallItem = Extract<Item, { type: 'tool_call' }>
type ApprovalItem = Extract<Item, { type: 'approval' }>

interface GenerationIntent {
  readonly call: LlmToolCall
  readonly item: ToolCallItem
}

interface GenerationOutcome {
  readonly stopReason: 'end_turn' | 'decision' | 'max_tokens' | 'tool_calls'
  readonly assistantMessage: LlmMessage
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
      trigger: 'user',
      input: input.input,
      structureVersion: input.structureVersion,
      now,
    })
    await this.#append(input.threadId, turnStartedEvent(turn))

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
        history: [{ role: 'user', content: input.input }],
        stepIndex: 0,
      },
      input.signal,
    )
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

    let toolMessage: LlmMessage
    if (input.decision === 'approved') {
      const outcome = await this.#options.tools.execute({
        call: pending.call,
        threadId: input.threadId,
        turnId: input.turnId,
        itemId: pending.toolItem.id,
        approval: 'approved',
        signal: input.signal,
      })
      if (outcome.kind === 'approval-required') {
        throw new Error(
          'Tool slot requested another approval for an approved call',
        )
      }
      toolMessage = await this.#completeToolItem(
        input.threadId,
        pending.toolItem,
        outcome,
        now,
      )
    } else {
      toolMessage = await this.#completeToolItem(
        input.threadId,
        pending.toolItem,
        {
          kind: 'result',
          output: { rejected: true },
          content: 'The user rejected this tool call.',
          isError: true,
        },
        now,
      )
    }
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

    while (true) {
      if (signal?.aborted) return this.#cancel(state)

      if (state.stepIndex >= maxSteps) {
        return this.#fail(state, `Exceeded the maximum of ${maxSteps} steps`)
      }

      const generated = await this.#generate(state, signal, maxRetries)
      if (!generated.ok) {
        if (signal?.aborted) return this.#cancel(state)
        return this.#fail(state, generated.error ?? 'Generation failed')
      }
      const outcome = generated.outcome

      // Act: record the assistant message, then run its tool intents.
      state.history.push(outcome.assistantMessage)
      for (const intent of outcome.intents) {
        if (signal?.aborted) return this.#cancel(state)
        const result = await this.#options.tools.execute({
          call: intent.call,
          threadId: state.turn.threadId,
          turnId: state.turn.id,
          itemId: intent.item.id,
          signal,
        })
        if (result.kind === 'approval-required') {
          return this.#suspend(state, intent, result)
        }
        state.history.push(
          await this.#completeToolItem(
            state.turn.threadId,
            intent.item,
            result,
            this.#now(),
          ),
        )
      }

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
      if (outcome.stopReason === 'max_tokens') {
        return this.#fail(state, 'Model hit the output token limit')
      }
      // tool_calls: loop again with the recorded results.
      state.stepIndex = nextStepIndex
    }
  }

  // -----------------------------------------------------------------------
  // Act: one generation with retry classification
  // -----------------------------------------------------------------------

  async #generate(
    state: LoopState,
    signal: AbortSignal | undefined,
    maxRetries: number,
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

    const messages: LlmMessage[] = [
      ...state.history,
      ...(retrieved ?? []),
      ...(planned ?? []),
    ]

    let lastError: unknown
    for (let retry = 0; retry <= maxRetries; retry += 1) {
      try {
        return await this.#attempt(state, messages, signal)
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

  async #attempt(
    state: LoopState,
    messages: readonly LlmMessage[],
    signal: AbortSignal | undefined,
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

    const call = this.#options.llm.generate(
      { messages: [...messages], tools: this.#options.toolSpecs ?? [] },
      { signal },
    )

    const deltas: string[] = []
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
        await this.#append(
          threadId,
          itemDeltaEvent(
            { threadId, turnId, itemId: assistantItem.id },
            event.delta,
          ),
        )
      } else if (event.kind === 'tool-intent') {
        const toolItem = newItem({
          threadId,
          turnId,
          type: 'tool_call',
          payload: {
            toolId: event.call.toolId,
            callId: event.call.callId,
            input: event.call.input,
          },
          now: this.#now(),
        })
        await this.#append(threadId, itemStartedEvent(toolItem))
        intents.push({ call: event.call, item: toolItem })
      } else {
        decision = event.decision
      }
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
      payload: { role: 'assistant', content },
    }
    await this.#append(threadId, itemCompletedEvent(completedItem))

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
    result: Extract<AgentLoopToolOutcome, { kind: 'approval-required' }>,
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
    result: Extract<AgentLoopToolOutcome, { kind: 'result' }>,
    now: string,
  ): Promise<LlmMessage> {
    const completed: ToolCallItem = {
      ...toolItem,
      status: 'completed',
      endedAt: now,
      payload: { ...toolItem.payload, output: result.output },
    }
    await this.#append(threadId, itemCompletedEvent(completed))
    return {
      role: 'tool',
      callId: completed.payload.callId,
      toolId: completed.payload.toolId,
      content: result.content,
      isError: result.isError,
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
    const stepIndex = last !== undefined ? last.stepIndex + 1 : 0
    const commitSequence = last?.sequence ?? 0

    const history = this.#rebuildHistory(events, commitSequence)
    const pendingApproval = this.#findPendingApproval(events)

    return {
      state: { turn, history, stepIndex },
      pendingApproval,
    }
  }

  #rebuildHistory(
    events: readonly TurnScopedEvent[],
    commitSequence: number,
  ): LlmMessage[] {
    const history: LlmMessage[] = []
    for (const event of events) {
      if (event.sequence > commitSequence) continue
      if (event.event !== 'item.completed') continue
      const item = event.item
      if (item.type === 'message') {
        if (item.payload.role === 'user') {
          history.push({ role: 'user', content: item.payload.content })
        } else if (item.payload.role === 'assistant') {
          history.push({ role: 'assistant', content: item.payload.content })
        }
      } else if (item.type === 'tool_call') {
        const output = item.payload.output
        history.push({
          role: 'tool',
          callId: item.payload.callId,
          toolId: item.payload.toolId,
          content: typeof output === 'string' ? output : JSON.stringify(output),
        })
      }
    }
    return history
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

  async #append(
    threadId: ThreadId,
    ...events: readonly NewChronicleEvent[]
  ): Promise<void> {
    if (events.length === 0) return
    await appendThreadEvents(this.#options.store, threadId, events)
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
