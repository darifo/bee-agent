import type { ChronicleStore } from '@bee-agent/knowledge'
import { LEARNING_STREAM_ID } from './events.ts'
import { learningDriftCheckedEvent } from './events.ts'
import type { ChronicleProposalStore } from './store.ts'
import type { DerivedTurn } from './loop.ts'
import { deriveTurnsById, selectAndDerive } from './loop.ts'
import type { ImprovementProposal } from './proposal.ts'

/**
 * The drift monitor (architecture §11.5, v1 refactor plan §5.6 WF5-E):
 * time-out validation for adopted changes. After activation, real turns
 * that arrive are the holdout the proposal never saw — if the target
 * metric regresses against the pre-adoption evidence baseline, the
 * proposal rolls back automatically with the numbers in the reason. Every
 * check appends a durable `learning.drift.checked` fact, so the "uncontrolled
 * drift" risk has an audit trail even when nothing regresses.
 */

export interface DriftBudget {
  /** Post-adoption turns required before a verdict is allowed. */
  readonly minMonitorTurns: number
  /** Absolute failure-rate margin over baseline that counts as regression. */
  readonly failureRateMargin: number
  /** Minimum failures in the window before regression is declared. */
  readonly minMonitorFailures: number
  /** Checkpoint average margin over baseline for planning proposals. */
  readonly checkpointMargin: number
  /** How many recent turns the monitoring window may inspect. */
  readonly maxTrajectories: number
}

export const DEFAULT_DRIFT_BUDGET: DriftBudget = {
  minMonitorTurns: 2,
  failureRateMargin: 0.25,
  minMonitorFailures: 2,
  checkpointMargin: 2,
  maxTrajectories: 20,
}

export type DriftVerdict = 'ok' | 'regression' | 'insufficient-samples'

export interface DriftCheck {
  readonly proposalId: string
  readonly metric: string
  readonly baseline: number
  readonly monitor: number
  readonly monitorTurns: number
  readonly verdict: DriftVerdict
  readonly rolledBack: boolean
}

export interface DriftReport {
  readonly ranAt: string
  readonly checked: readonly DriftCheck[]
}

interface ActiveActivation {
  readonly proposalId: string
  readonly activatedAt: string
}

export interface DriftMonitorOptions {
  readonly store: ChronicleStore
  readonly proposals: ChronicleProposalStore
  readonly budget?: Partial<DriftBudget> | undefined
  readonly now?: (() => string) | undefined
}

export class DriftMonitor {
  readonly #store: ChronicleStore
  readonly #proposals: ChronicleProposalStore
  readonly #budget: DriftBudget
  readonly #now: () => string

  constructor(options: DriftMonitorOptions) {
    this.#store = options.store
    this.#proposals = options.proposals
    this.#budget = { ...DEFAULT_DRIFT_BUDGET, ...options.budget }
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  budget(): DriftBudget {
    return this.#budget
  }

  /**
   * Checks every promoted proposal with an active activation. The
   * activation registry is replayed from the learning stream, so the
   * monitor works identically after a restart.
   */
  async check(): Promise<DriftReport> {
    const activations = await this.#activeActivations()
    const checks: DriftCheck[] = []
    for (const activation of activations) {
      const proposal = await this.#proposals.get(activation.proposalId)
      if (proposal === undefined || proposal.status !== 'promoted') continue
      checks.push(await this.#checkProposal(proposal, activation))
    }

    const report: DriftReport = { ranAt: this.#now(), checked: checks }
    if (activations.length > 0) {
      await this.#store.append(
        LEARNING_STREAM_ID,
        [
          learningDriftCheckedEvent({
            ranAt: report.ranAt,
            checked: [...checks],
          }),
        ],
        {
          expectedSequence:
            (await this.#store.getLatestSequence(LEARNING_STREAM_ID)) + 1,
        },
      )
    }
    return report
  }

  async #checkProposal(
    proposal: ImprovementProposal,
    activation: ActiveActivation,
  ): Promise<DriftCheck> {
    const baselineTurns = await deriveTurnsById(
      this.#store,
      proposal.basedOnTrajectoryIds,
    )
    const monitorTurns = await selectAndDerive(
      this.#store,
      {
        maxTrajectories: this.#budget.maxTrajectories,
        maxProposalsPerRun: 1,
        toolUsageSkillThreshold: Number.MAX_SAFE_INTEGER,
        toolFailureThreshold: Number.MAX_SAFE_INTEGER,
        longTurnSteps: Number.MAX_SAFE_INTEGER,
      },
      { since: activation.activatedAt },
    )
    const change = proposal.proposedChange as { toolId?: string }
    const target = change.toolId

    let metric: string
    let baselineValue: number
    let monitorValue: number
    let regressed: boolean
    if (target !== undefined) {
      metric = `failure-rate:${target}`
      const rate = (turns: readonly DerivedTurn[]) => {
        let calls = 0
        let failures = 0
        for (const turn of turns) {
          for (const call of turn.toolCalls) {
            if (call.toolId !== target) continue
            calls += 1
            if (call.isError) failures += 1
          }
        }
        return { rate: calls === 0 ? 0 : failures / calls, failures, calls }
      }
      const baseline = rate(baselineTurns)
      const monitor = rate(monitorTurns)
      baselineValue = baseline.rate
      monitorValue = monitor.rate
      regressed =
        monitor.calls > 0 &&
        monitor.failures >= this.#budget.minMonitorFailures &&
        monitor.rate > baseline.rate + this.#budget.failureRateMargin
    } else {
      metric = 'average-checkpoints'
      const avg = (turns: readonly DerivedTurn[]) =>
        turns.length === 0
          ? 0
          : turns.reduce((sum, turn) => sum + turn.checkpoints, 0) /
            turns.length
      baselineValue = avg(baselineTurns)
      monitorValue = avg(monitorTurns)
      regressed =
        monitorTurns.length > 0 &&
        monitorValue > baselineValue + this.#budget.checkpointMargin
    }

    let verdict: DriftVerdict
    let rolledBack = false
    if (monitorTurns.length < this.#budget.minMonitorTurns) {
      verdict = 'insufficient-samples'
    } else if (regressed) {
      verdict = 'regression'
      await this.#proposals.transition(proposal.id, {
        to: 'rolled-back',
        expectedVersion: proposal.version,
        reason: `drift monitor: ${metric} regressed from ${baselineValue.toFixed(2)} to ${monitorValue.toFixed(2)}`,
      })
      rolledBack = true
    } else {
      verdict = 'ok'
    }

    return {
      proposalId: proposal.id,
      metric,
      baseline: baselineValue,
      monitor: monitorValue,
      monitorTurns: monitorTurns.length,
      verdict,
      rolledBack,
    }
  }

  async #activeActivations(): Promise<ActiveActivation[]> {
    const active = new Map<string, ActiveActivation>()
    for await (const event of this.#store.readStream(LEARNING_STREAM_ID)) {
      if (event.eventType === 'learning.proposal.activated') {
        const payload = event.payload as {
          proposalId: string
          activatedAt: string
        }
        active.set(payload.proposalId, {
          proposalId: payload.proposalId,
          activatedAt: payload.activatedAt,
        })
      } else if (event.eventType === 'learning.proposal.activation-reverted') {
        const payload = event.payload as { proposalId: string }
        active.delete(payload.proposalId)
      }
    }
    return [...active.values()]
  }
}
