import type { ChronicleStore } from '@bee-agent/knowledge'
import { LEARNING_STREAM_ID, learningLoopRunEvent } from './events.ts'
import type { LearningRunReport } from './events.ts'
import type { ChronicleProposalStore, CreateProposalInput } from './store.ts'
import { MAX_LOOP_AUTONOMY_LEVEL } from './proposal.ts'

/**
 * The slow loop core (architecture §11.2, v1 refactor plan §5.6 WF5-A):
 * Selection → Derivation → Consolidation → Pattern discovery → Proposal
 * generation, as one background pass with its own budget. It reads durable
 * facts only, writes proposals only, and never blocks a Turn — foreground
 * execution and background learning are separated (ADR 0025).
 *
 * Selection and derivation here are deliberately conservative deterministic
 * baselines (same discipline as the memory deriver): they recognize overt
 * signals — high-frequency tool usage, repeated tool failures, near-cap
 * turn lengths — and leave richer inference to injectable stages. Thread
 * events are parsed structurally so learning never depends on the thread
 * package.
 */

export interface LearningLoopBudget {
  /** How many recent turns selection may inspect per run. */
  readonly maxTrajectories: number
  /** Hard cap on proposals a single run may create. */
  readonly maxProposalsPerRun: number
  /** Tool usages across selected turns before a skill proposal fires. */
  readonly toolUsageSkillThreshold: number
  /** Failures of one tool before a guardrail observation fires. */
  readonly toolFailureThreshold: number
  /** Checkpoints before a turn counts as "near the step cap". */
  readonly longTurnSteps: number
}

export const DEFAULT_LEARNING_BUDGET: LearningLoopBudget = {
  maxTrajectories: 20,
  maxProposalsPerRun: 3,
  toolUsageSkillThreshold: 3,
  toolFailureThreshold: 2,
  longTurnSteps: 6,
}

/** One derived turn: the deterministic facts the pattern stage consumes. */
export interface DerivedTurn {
  readonly threadId: string
  readonly turnId: string
  readonly status: 'completed' | 'failed' | 'cancelled' | string
  readonly checkpoints: number
  readonly toolCalls: readonly {
    readonly toolId: string
    readonly isError: boolean
  }[]
}

/** Structural shape of thread stream events the selector consumes. */
function parseTurnStarted(
  payload: unknown,
): { threadId: string; turnId: string; status: string } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const turn = (payload as { turn?: unknown }).turn
  if (typeof turn !== 'object' || turn === null) return undefined
  const { id, threadId, status } = turn as Record<string, unknown>
  if (typeof id !== 'string' || typeof threadId !== 'string') return undefined
  return {
    threadId,
    turnId: id,
    status: typeof status === 'string' ? status : 'active',
  }
}

function parseItemId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const item = (payload as { item?: unknown }).item
  if (typeof item !== 'object' || item === null) return undefined
  const { id, type, payload: itemPayload } = item as Record<string, unknown>
  if (typeof id !== 'string' || type !== 'tool_call') return undefined
  const toolId = (itemPayload as Record<string, unknown> | undefined)?.toolId
  if (typeof toolId !== 'string') return undefined
  return id
}

/**
 * Selection + derivation: walks thread streams in reverse recency order,
 * keeps the most recent budget.maxTrajectories *tool-using* turns, and
 * derives their deterministic facts. Failed turns are kept alongside
 * completed ones — failures are primary learning evidence (§11.2).
 */
export interface SelectionOptions {
  /** Only keep turns whose `turn.started` was ingested after this time. */
  readonly since?: string | undefined
}

export async function selectAndDerive(
  store: ChronicleStore,
  budget: LearningLoopBudget,
  options: SelectionOptions = {},
): Promise<DerivedTurn[]> {
  const derived: DerivedTurn[] = []
  const streams = [...(await store.listStreams())]
    .filter((streamId) => streamId.startsWith('thread:'))
    .sort()
  for (const streamId of streams) {
    if (derived.length >= budget.maxTrajectories) break
    const turns = new Map<
      string,
      {
        threadId: string
        status: string
        checkpoints: number
        toolCalls: { toolId: string; isError: boolean }[]
      }
    >()
    for await (const event of store.readStream(streamId)) {
      if (event.eventType === 'turn.started') {
        const parsed = parseTurnStarted(event.payload)
        if (
          parsed !== undefined &&
          !turns.has(parsed.turnId) &&
          (options.since === undefined || event.ingestTime > options.since)
        ) {
          turns.set(parsed.turnId, {
            threadId: parsed.threadId,
            status: parsed.status,
            checkpoints: 0,
            toolCalls: [],
          })
        }
        continue
      }
      if (event.eventType === 'agent.checkpoint') {
        const turn = turns.get(event.turnId ?? '')
        if (turn !== undefined) turn.checkpoints += 1
        continue
      }
      if (event.eventType === 'item.completed') {
        const itemId = parseItemId(event.payload)
        if (itemId === undefined) continue
        const turn = turns.get(event.turnId ?? '')
        if (turn === undefined) continue
        const item = (event.payload as { item: { payload: unknown } }).item
          .payload as Record<string, unknown>
        turn.toolCalls.push({
          toolId: String(item.toolId),
          isError: item.isError === true,
        })
      }
    }
    for (const [turnId, turn] of turns) {
      if (turn.toolCalls.length === 0) continue
      derived.push({
        threadId: turn.threadId,
        turnId,
        status: turn.status,
        checkpoints: turn.checkpoints,
        toolCalls: turn.toolCalls,
      })
    }
  }
  return derived.slice(-budget.maxTrajectories)
}

/** Pattern stage output: a fully-formed proposal candidate. */
export type ProposalCandidate = Omit<CreateProposalInput, 'now' | 'origin'>

/**
 * Pattern discovery (deterministic baseline): overt signals become
 * candidates. Order is stable so identical inputs produce identical
 * proposals — consolidation and audits rely on that.
 */
export function discoverPatterns(
  turns: readonly DerivedTurn[],
  budget: LearningLoopBudget,
): ProposalCandidate[] {
  const candidates: ProposalCandidate[] = []
  const usage = new Map<string, { count: number; refs: DerivedTurn[] }>()
  const failures = new Map<string, { count: number; refs: DerivedTurn[] }>()
  const longTurns: DerivedTurn[] = []

  for (const turn of turns) {
    if (turn.checkpoints >= budget.longTurnSteps) longTurns.push(turn)
    for (const call of turn.toolCalls) {
      const used = usage.get(call.toolId) ?? { count: 0, refs: [] }
      used.count += 1
      used.refs.push(turn)
      usage.set(call.toolId, used)
      if (call.isError) {
        const failed = failures.get(call.toolId) ?? { count: 0, refs: [] }
        failed.count += 1
        failed.refs.push(turn)
        failures.set(call.toolId, failed)
      }
    }
  }

  const refsOf = (refs: DerivedTurn[]) =>
    [...new Map(refs.map((t) => [t.turnId, t])).values()].map((t) => ({
      threadId: t.threadId,
      turnId: t.turnId,
    }))

  for (const [toolId, { count, refs }] of usage) {
    if (count < budget.toolUsageSkillThreshold) continue
    candidates.push({
      type: 'skill',
      targetKey: `skill:${toolId}`,
      basedOnTrajectoryIds: refsOf(refs),
      hypothesis: `Tool '${toolId}' was used ${count} times across recent turns; packaging its typical invocation as a Skill candidate would reduce per-turn tool discovery cost.`,
      proposedChange: { kind: 'skill-candidate', toolId, usageCount: count },
      expectedBenefits: [
        `Fewer tokens spent re-describing '${toolId}' usage each turn`,
      ],
      risks: ['A stale skill could encode an outdated invocation pattern'],
      evaluationPlan:
        'Replay recorded trajectories with and without the skill candidate and compare tool-selection accuracy and token cost.',
      rollbackPlan: 'Retract the skill and remove it from the active bundle.',
      autonomyLevel: 2,
    })
  }
  for (const [toolId, { count, refs }] of failures) {
    if (count < budget.toolFailureThreshold) continue
    candidates.push({
      type: 'guardrail',
      targetKey: `tool-failure:${toolId}`,
      basedOnTrajectoryIds: refsOf(refs),
      hypothesis: `Tool '${toolId}' failed ${count} times recently; a usage guardrail or clearer invocation guidance may prevent repeats.`,
      proposedChange: {
        kind: 'failure-observation',
        toolId,
        failureCount: count,
      },
      expectedBenefits: ['Fewer repeated failing invocations'],
      risks: ['Over-restricting a tool that fails for benign reasons'],
      evaluationPlan:
        'Compare failure rates for the tool before and after the guidance change on held-out trajectories.',
      rollbackPlan: 'Remove the guidance entry; no persistent state changes.',
      autonomyLevel: 0,
    })
  }
  if (longTurns.length > 0) {
    candidates.push({
      type: 'planning-policy',
      targetKey: 'long-turns',
      basedOnTrajectoryIds: refsOf(longTurns),
      hypothesis: `${longTurns.length} recent turns ran past ${budget.longTurnSteps} steps; earlier decomposition or tighter plans may cut cost.`,
      proposedChange: {
        kind: 'long-turn-observation',
        turns: longTurns.length,
      },
      expectedBenefits: ['Shorter average turns', 'Lower token cost per task'],
      risks: ['Over-decomposition of genuinely complex tasks'],
      evaluationPlan:
        'Measure step counts on held-out tasks with the adjusted planner thresholds.',
      rollbackPlan: 'Restore the previous planner configuration.',
      autonomyLevel: 0,
    })
  }
  return candidates
}

export interface LearningLoopOptions {
  readonly store: ChronicleStore
  readonly proposals: ChronicleProposalStore
  readonly budget?: Partial<LearningLoopBudget> | undefined
  readonly now?: (() => string) | undefined
}

/**
 * One budgeted background pass. Failures of a single candidate never abort
 * the run; every run appends a durable `learning.loop.run` report, so the
 * loop itself is auditable.
 */
export class LearningLoop {
  readonly #store: ChronicleStore
  readonly #proposals: ChronicleProposalStore
  readonly #budget: LearningLoopBudget
  readonly #now: () => string

  constructor(options: LearningLoopOptions) {
    this.#store = options.store
    this.#proposals = options.proposals
    this.#budget = { ...DEFAULT_LEARNING_BUDGET, ...options.budget }
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  budget(): LearningLoopBudget {
    return this.#budget
  }

  async run(): Promise<LearningRunReport> {
    const turns = await selectAndDerive(this.#store, this.#budget)
    const candidates = discoverPatterns(turns, this.#budget)

    const created: string[] = []
    let skippedDuplicates = 0
    for (const candidate of candidates) {
      if (created.length >= this.#budget.maxProposalsPerRun) break
      if (await this.#proposals.hasOpenTarget(candidate.targetKey)) {
        skippedDuplicates += 1
        continue
      }
      if (candidate.autonomyLevel > MAX_LOOP_AUTONOMY_LEVEL) continue
      const proposal = await this.#proposals.create({
        ...candidate,
        origin: 'loop',
        now: this.#now(),
      })
      created.push(proposal.id)
    }

    const report: LearningRunReport = {
      ranAt: this.#now(),
      selectedTrajectories: turns.length,
      derivedTurns: turns.length,
      patternsFound: candidates.length,
      proposalsCreated: created,
      skippedDuplicates,
      budget: {
        maxTrajectories: this.#budget.maxTrajectories,
        maxProposalsPerRun: this.#budget.maxProposalsPerRun,
      },
    }
    const expected =
      (await this.#store.getLatestSequence(LEARNING_STREAM_ID)) + 1
    await this.#store.append(
      LEARNING_STREAM_ID,
      [learningLoopRunEvent(report)],
      {
        expectedSequence: expected,
      },
    )
    return report
  }
}

/**
 * Re-derives specific turns by id — completed turns are immutable in
 * Chronicle, so this reproduces the exact pre-adoption evidence the
 * proposal was based on (the drift monitor's baseline).
 */
export async function deriveTurnsById(
  store: ChronicleStore,
  refs: readonly { threadId: string; turnId: string }[],
): Promise<DerivedTurn[]> {
  const derived: DerivedTurn[] = []
  for (const ref of refs) {
    let turn:
      | {
          threadId: string
          status: string
          checkpoints: number
          toolCalls: { toolId: string; isError: boolean }[]
        }
      | undefined
    for await (const event of store.readStream(`thread:${ref.threadId}`)) {
      if (event.eventType === 'turn.started') {
        const parsed = parseTurnStarted(event.payload)
        if (parsed !== undefined && parsed.turnId === ref.turnId) {
          turn = {
            threadId: parsed.threadId,
            status: parsed.status,
            checkpoints: 0,
            toolCalls: [],
          }
        }
        continue
      }
      if (turn === undefined) continue
      if (event.eventType === 'agent.checkpoint') {
        if ((event.turnId ?? '') === ref.turnId) turn.checkpoints += 1
        continue
      }
      if (event.eventType === 'item.completed') {
        if ((event.turnId ?? '') !== ref.turnId) continue
        if (parseItemId(event.payload) === undefined) continue
        const item = (event.payload as { item: { payload: unknown } }).item
          .payload as Record<string, unknown>
        turn.toolCalls.push({
          toolId: String(item.toolId),
          isError: item.isError === true,
        })
      }
    }
    if (turn !== undefined) {
      derived.push({
        threadId: turn.threadId,
        turnId: ref.turnId,
        status: turn.status,
        checkpoints: turn.checkpoints,
        toolCalls: turn.toolCalls,
      })
    }
  }
  return derived
}
