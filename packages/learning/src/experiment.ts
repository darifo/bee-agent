import { createHash } from 'node:crypto'
import { canonicalJson } from '@bee-agent/kernel'
import type { ChronicleStore } from '@bee-agent/knowledge'
import type { NewChronicleEvent } from '@bee-agent/knowledge'
import { LEARNING_STREAM_ID } from './events.ts'
import {
  learningExperimentCompletedEvent,
  learningExperimentFailedEvent,
  learningExperimentStartedEvent,
} from './events.ts'
import type { ChronicleProposalStore } from './store.ts'
import type { DerivedTurn, LearningLoopBudget } from './loop.ts'
import { selectAndDerive } from './loop.ts'
import type { ImprovementProposal } from './proposal.ts'

/**
 * ExperimentWorld (architecture §11.2 stages 6–8, v1 refactor plan §5.6
 * WF5-C): where a proposal earns its evidence. Each experiment freezes a
 * dataset of derived trajectories (digest-pinned, so later conversation
 * activity cannot drift what is tested), runs an injectable evaluator in
 * isolation — read-only facts, no memory/structure/behavior writes — and
 * emits a durable report with a content-addressed changeset and a rollback
 * package. The evidence gate then moves the proposal: failed evidence
 * archives automatically; passing evidence waits in review for the user
 * (ADR 0026).
 */

export interface FrozenTrajectory {
  readonly threadId: string
  readonly turnId: string
  readonly derived: DerivedTurn
}

export interface FrozenDataset {
  readonly trajectories: readonly FrozenTrajectory[]
  readonly digest: string
  readonly frozenAt: string
}

export type ExperimentVerdict = 'accept' | 'reject' | 'inconclusive'

export interface RollbackPackage {
  readonly kind:
    'no-op' | 'retract-skill' | 'remove-guardrail' | 'restore-planner-config'
  readonly description: string
}

export interface ExperimentReport {
  readonly id: string
  readonly proposalId: string
  readonly datasetDigest: string
  readonly evaluatorId: string
  readonly verdict: ExperimentVerdict
  readonly metrics: Readonly<Record<string, number>>
  readonly notes: string | undefined
  readonly changesetDigest: string | undefined
  readonly rollback: RollbackPackage
  readonly startedAt: string
  readonly completedAt: string
}

export interface EvaluatorInput {
  readonly proposal: ImprovementProposal
  readonly dataset: FrozenDataset
}

export interface EvaluatorOutput {
  readonly verdict: ExperimentVerdict
  readonly metrics: Readonly<Record<string, number>>
  readonly notes?: string | undefined
}

/** Isolated evaluation strategy; injectable for richer future evaluators. */
export interface Evaluator {
  readonly id: string
  evaluate(input: EvaluatorInput): Promise<EvaluatorOutput>
}

export function freezeDataset(
  trajectories: readonly DerivedTurn[],
  frozenAt: string,
): FrozenDataset {
  const digest = `sha256:${createHash('sha256')
    .update(
      canonicalJson(
        trajectories.map((turn) => [
          turn.threadId,
          turn.turnId,
          turn.status,
          turn.checkpoints,
          turn.toolCalls,
        ]),
      ),
    )
    .digest('hex')}`
  return {
    trajectories: trajectories.map((turn) => ({
      threadId: turn.threadId,
      turnId: turn.turnId,
      derived: turn,
    })),
    digest,
    frozenAt,
  }
}

export function changesetDigestOf(proposal: ImprovementProposal): string {
  return `sha256:${createHash('sha256')
    .update(
      canonicalJson({
        type: proposal.type,
        targetKey: proposal.targetKey,
        proposedChange: proposal.proposedChange,
        basedOn: proposal.basedOnTrajectoryIds,
      }),
    )
    .digest('hex')}`
}

function rollbackFor(proposal: ImprovementProposal): RollbackPackage {
  switch (proposal.type) {
    case 'skill':
      return {
        kind: 'retract-skill',
        description: `Retract the skill candidate for '${proposal.targetKey}' and remove it from the active bundle.`,
      }
    case 'guardrail':
      return {
        kind: 'remove-guardrail',
        description: 'Remove the guidance entry; no persistent state changes.',
      }
    case 'planning-policy':
      return {
        kind: 'restore-planner-config',
        description: 'Restore the previous planner configuration.',
      }
    default:
      return {
        kind: 'no-op',
        description: 'Proposal-only change; nothing to roll back.',
      }
  }
}

/**
 * The default evaluator ("evidence-verify@1"): recomputes the proposal's
 * claimed pattern directly from the frozen dataset and refuses claims the
 * data does not support. This is the minimal anti-self-poisoning gate —
 * the slow loop cannot launder invented evidence through an experiment,
 * because the experiment re-derives the counts itself.
 */
export class EvidenceVerifyEvaluator implements Evaluator {
  readonly id = 'evidence-verify@1'

  async evaluate(input: EvaluatorInput): Promise<EvaluatorOutput> {
    const change = input.proposal.proposedChange as {
      kind?: string
      toolId?: string
      usageCount?: number
      failureCount?: number
      turns?: number
    }
    let usage = 0
    let failures = 0
    let longTurns = 0
    for (const frozen of input.dataset.trajectories) {
      if (frozen.derived.checkpoints >= 6) longTurns += 1
      for (const call of frozen.derived.toolCalls) {
        if (call.toolId !== change.toolId) continue
        usage += 1
        if (call.isError) failures += 1
      }
    }
    const metrics: Record<string, number> = {
      trajectoryCount: input.dataset.trajectories.length,
      verifiedUsage: usage,
      verifiedFailures: failures,
      verifiedLongTurns: longTurns,
    }
    if (change.kind === 'skill-candidate') {
      metrics.claimedUsage = change.usageCount ?? -1
      const holds = usage >= (change.usageCount ?? 0) && usage > 0
      return {
        verdict: holds ? 'accept' : 'reject',
        metrics,
        notes: holds
          ? undefined
          : `Claimed ${change.usageCount} usages of '${change.toolId}', the frozen data shows ${usage}.`,
      }
    }
    if (change.kind === 'failure-observation') {
      metrics.claimedFailures = change.failureCount ?? -1
      const holds = failures >= (change.failureCount ?? 0) && failures > 0
      return {
        verdict: holds ? 'accept' : 'reject',
        metrics,
        notes: holds
          ? undefined
          : `Claimed ${change.failureCount} failures of '${change.toolId}', the frozen data shows ${failures}.`,
      }
    }
    if (change.kind === 'long-turn-observation') {
      metrics.claimedLongTurns = change.turns ?? -1
      const holds = longTurns >= (change.turns ?? 0) && longTurns > 0
      return {
        verdict: holds ? 'accept' : 'reject',
        metrics,
        notes: holds
          ? undefined
          : `Claimed ${change.turns} long turns, the frozen data shows ${longTurns}.`,
      }
    }
    return {
      verdict: 'inconclusive',
      metrics,
      notes: `No deterministic verification for change kind '${change.kind}'; awaiting a dedicated evaluator.`,
    }
  }
}

export interface ExperimentWorldOptions {
  readonly store: ChronicleStore
  readonly proposals: ChronicleProposalStore
  readonly evaluators?: readonly Evaluator[] | undefined
  readonly budget?: Partial<LearningLoopBudget> | undefined
  readonly now?: (() => string) | undefined
}

export class ExperimentNotAllowedError extends Error {
  constructor(
    readonly proposalId: string,
    readonly status: string,
  ) {
    super(
      `Proposal '${proposalId}' is '${status}'; experiments start from draft or review`,
    )
    this.name = 'ExperimentNotAllowedError'
  }
}

/**
 * Runs one isolated experiment for a proposal: freeze → enter testing →
 * evaluate → evidence gate → durable report. Failed evaluation infra
 * (throwing evaluators) fails the experiment without touching the proposal
 * beyond leaving it in testing for retry.
 */
export class ExperimentWorld {
  readonly #store: ChronicleStore
  readonly #proposals: ChronicleProposalStore
  readonly #evaluators: readonly Evaluator[]
  readonly #budget: LearningLoopBudget
  readonly #now: () => string
  readonly #reports = new Map<string, ExperimentReport>()

  constructor(options: ExperimentWorldOptions) {
    this.#store = options.store
    this.#proposals = options.proposals
    this.#evaluators = options.evaluators ?? [new EvidenceVerifyEvaluator()]
    this.#budget = {
      maxTrajectories: 20,
      maxProposalsPerRun: 3,
      toolUsageSkillThreshold: 3,
      toolFailureThreshold: 2,
      longTurnSteps: 6,
      ...(options.budget ?? {}),
    }
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  reportsFor(proposalId: string): readonly ExperimentReport[] {
    return [...this.#reports.values()]
      .filter((report) => report.proposalId === proposalId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  }

  /** Replays the learning stream to recover experiment reports. */
  async rebuild(): Promise<void> {
    this.#reports.clear()
    await this.#replayProposals()
    for await (const event of this.#store.readStream(LEARNING_STREAM_ID)) {
      if (event.eventType !== 'learning.experiment.completed') continue
      const payload = event.payload as ExperimentReport
      this.#reports.set(payload.id, payload)
    }
  }

  async #replayProposals(): Promise<void> {
    await this.#proposals.rebuild()
  }

  async runForProposal(proposalId: string): Promise<ExperimentReport> {
    const proposal = await this.#proposals.get(proposalId)
    if (proposal === undefined) {
      throw new Error(`Improvement proposal '${proposalId}' was not found`)
    }
    if (proposal.status !== 'draft' && proposal.status !== 'review') {
      throw new ExperimentNotAllowedError(proposalId, proposal.status)
    }

    const startedAt = this.#now()
    const experimentId = crypto.randomUUID()
    const trajectories = await selectAndDerive(this.#store, this.#budget)
    const dataset = freezeDataset(trajectories, startedAt)
    const evaluator = this.#pickEvaluator()

    await this.#append(
      learningExperimentStartedEvent({
        experimentId,
        proposalId,
        datasetDigest: dataset.digest,
        evaluatorId: evaluator.id,
        startedAt,
      }),
    )
    const entered = await this.#proposals.transition(proposalId, {
      to: 'testing',
      expectedVersion: proposal.version,
      reason: `experiment ${experimentId} started`,
    })

    let output: EvaluatorOutput
    try {
      output = await evaluator.evaluate({ proposal, dataset })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.#append(
        learningExperimentFailedEvent({
          experimentId,
          proposalId,
          evaluatorId: evaluator.id,
          message,
          failedAt: this.#now(),
        }),
      )
      throw error
    }

    const completedAt = this.#now()
    const changesetDigest = changesetDigestOf(proposal)
    const report: ExperimentReport = {
      id: experimentId,
      proposalId,
      datasetDigest: dataset.digest,
      evaluatorId: evaluator.id,
      verdict: output.verdict,
      metrics: output.metrics,
      notes: output.notes,
      changesetDigest,
      rollback: rollbackFor(proposal),
      startedAt,
      completedAt,
    }
    await this.#append(
      learningExperimentCompletedEvent({
        experimentId,
        proposalId,
        datasetDigest: dataset.digest,
        evaluatorId: evaluator.id,
        verdict: output.verdict,
        metrics: output.metrics,
        ...(output.notes === undefined ? {} : { notes: output.notes }),
        changesetDigest,
        rollback: report.rollback,
        startedAt,
        completedAt,
      }),
    )

    // Evidence gate (§11.2 stage 8): failed evidence archives with the
    // reason; passing evidence waits in review for the user.
    const gate =
      output.verdict === 'reject'
        ? {
            to: 'rejected' as const,
            reason: 'evidence gate: claims not supported by the frozen dataset',
          }
        : {
            to: 'review' as const,
            reason: `experiment ${output.verdict}ed; awaiting user decision`,
          }
    await this.#proposals.transition(proposalId, {
      to: gate.to,
      expectedVersion: entered.version,
      reason: gate.reason,
    })

    this.#reports.set(report.id, report)
    return report
  }

  #pickEvaluator(): Evaluator {
    return this.#evaluators[0]!
  }

  async #append(...events: readonly NewChronicleEvent[]): Promise<void> {
    if (events.length === 0) return
    const expected =
      (await this.#store.getLatestSequence(LEARNING_STREAM_ID)) + 1
    await this.#store.append(LEARNING_STREAM_ID, events, {
      expectedSequence: expected,
    })
  }
}
