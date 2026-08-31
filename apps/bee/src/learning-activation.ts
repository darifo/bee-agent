import type { ChronicleStore, MemoryProvider } from '@bee-agent/knowledge'
import { LEARNING_STREAM_ID } from '@bee-agent/learning'
import {
  learningActivationRevertedEvent,
  learningProposalActivatedEvent,
} from '@bee-agent/learning'
import type { ImprovementProposal } from '@bee-agent/learning'

/**
 * Autonomy-level activation (architecture §11.4, v1 refactor plan §5.6
 * WF5-D): applying a promoted proposal through a governed channel — today
 * the memory provider, whose claims the recall hook actually injects, so
 * an activation is a real behavior change, not a stored intention. The
 * levels are enforced, not advisory: L0 never changes behavior (summary
 * only), L3 needs the worktree ChangeSet pipeline (not yet built), and
 * every activation records a durable fact plus keeps the one-click
 * rollback the autonomy table promises.
 */

export interface LearningActivationOptions {
  readonly store: ChronicleStore
  readonly memory: MemoryProvider
  /**
   * Change budget (§11.5 anti-drift): the maximum simultaneously active
   * activations. Reaching it requires rolling one back before activating
   * another improvement.
   */
  readonly maxActiveActivations?: number | undefined
  readonly now?: (() => string) | undefined
}

export class ActivationNotPermittedError extends Error {
  constructor(
    readonly proposalId: string,
    readonly reason: string,
  ) {
    super(`Activation of '${proposalId}' is not permitted: ${reason}`)
    this.name = 'ActivationNotPermittedError'
  }
}

export interface ActivationResult {
  readonly proposalId: string
  readonly claimId: string
  readonly via: 'memory-claim'
}

function claimStatementFor(proposal: ImprovementProposal): string {
  const change = proposal.proposedChange as {
    kind?: string
    toolId?: string
    usageCount?: number
    failureCount?: number
    turns?: number
  }
  switch (proposal.type) {
    case 'skill':
      return `Adopted usage pattern for tool '${change.toolId}' (from ${change.usageCount ?? 0} recent uses, learning proposal ${proposal.id}): package this invocation as a reusable skill and prefer it over re-describing the tool each time.`
    case 'guardrail':
      return `Adopted guidance for tool '${change.toolId}' (from ${change.failureCount ?? 0} recent failures, learning proposal ${proposal.id}): check the invocation shape before calling; repeated failures were observed with the current pattern.`
    case 'planning-policy':
      return `Adopted planning note (learning proposal ${proposal.id}): ${change.turns ?? 0} recent turns ran near the step cap; prefer decomposing similar tasks before executing.`
    default:
      return `Adopted learning proposal ${proposal.id} (${proposal.type}): ${proposal.hypothesis}`
  }
}

export class LearningActivationService {
  readonly #store: ChronicleStore
  readonly #memory: MemoryProvider
  readonly #maxActive: number
  readonly #now: () => string
  readonly #claims = new Map<string, string>() // proposalId → claimId

  constructor(options: LearningActivationOptions) {
    this.#store = options.store
    this.#memory = options.memory
    this.#maxActive = options.maxActiveActivations ?? 5
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  /** Recovers proposalId → claimId from the learning stream. */
  async rebuild(): Promise<void> {
    this.#claims.clear()
    for await (const event of this.#store.readStream(LEARNING_STREAM_ID)) {
      if (event.eventType === 'learning.proposal.activated') {
        const payload = event.payload as { proposalId: string; claimId: string }
        this.#claims.set(payload.proposalId, payload.claimId)
      } else if (event.eventType === 'learning.proposal.activation-reverted') {
        const payload = event.payload as { proposalId: string }
        this.#claims.delete(payload.proposalId)
      }
    }
  }

  claimIdOf(proposalId: string): string | undefined {
    return this.#claims.get(proposalId)
  }

  /** Applies a promoted proposal; idempotent per proposal. */
  async apply(proposal: ImprovementProposal): Promise<ActivationResult> {
    if (proposal.status !== 'promoted') {
      throw new ActivationNotPermittedError(
        proposal.id,
        `proposal is '${proposal.status}', not 'promoted'`,
      )
    }
    if (proposal.autonomyLevel === 0) {
      throw new ActivationNotPermittedError(
        proposal.id,
        'L0 proposals are evidence summaries and never change behavior',
      )
    }
    if (proposal.autonomyLevel >= 3) {
      throw new ActivationNotPermittedError(
        proposal.id,
        'L3 activations require the worktree ChangeSet pipeline',
      )
    }
    const existing = this.#claims.get(proposal.id)
    if (existing !== undefined) {
      return { proposalId: proposal.id, claimId: existing, via: 'memory-claim' }
    }
    if (this.#claims.size >= this.#maxActive) {
      throw new ActivationNotPermittedError(
        proposal.id,
        `change budget reached: ${this.#claims.size} active activations (max ${this.#maxActive}); roll one back first`,
      )
    }

    // Record the activation first so the claim's provenance cites the exact
    // learning-stream position that adopted it.
    const activatedAt = this.#now()
    const expected =
      (await this.#store.getLatestSequence(LEARNING_STREAM_ID)) + 1
    const claimId = crypto.randomUUID()
    const stored = (
      await this.#store.append(
        LEARNING_STREAM_ID,
        [
          learningProposalActivatedEvent({
            proposalId: proposal.id,
            via: 'memory-claim',
            claimId,
            activatedAt,
          }),
        ],
        { expectedSequence: expected },
      )
    )[0]!

    await this.#memory.ingest({
      claims: [
        {
          id: claimId,
          kind: proposal.type === 'skill' ? 'procedure' : 'fact',
          statement: claimStatementFor(proposal),
          subject:
            proposal.type === 'guardrail' || proposal.type === 'skill'
              ? { type: 'project' }
              : { type: 'user' },
          provenance: {
            streamId: LEARNING_STREAM_ID,
            sequence: stored.sequence,
          },
          confidence: 0.8,
          recordedAt: activatedAt,
        },
      ],
    })

    this.#claims.set(proposal.id, claimId)
    return { proposalId: proposal.id, claimId, via: 'memory-claim' }
  }

  /** Monitor-driven retraction by proposal id; idempotent when absent. */
  async revertByProposalId(
    proposalId: string,
    reason?: string,
  ): Promise<{ proposalId: string; claimId: string } | undefined> {
    const claimId = this.#claims.get(proposalId)
    if (claimId === undefined) return undefined
    await this.#memory.retract(
      claimId,
      reason ?? `learning proposal ${proposalId} rolled back`,
    )
    await this.#store.append(
      LEARNING_STREAM_ID,
      [
        learningActivationRevertedEvent({
          proposalId,
          claimId,
          ...(reason === undefined ? {} : { reason }),
          revertedAt: this.#now(),
        }),
      ],
      {
        expectedSequence:
          (await this.#store.getLatestSequence(LEARNING_STREAM_ID)) + 1,
      },
    )
    this.#claims.delete(proposalId)
    return { proposalId, claimId }
  }

  /** One-click rollback: retracts the activation claim durably. */
  async revert(
    proposal: ImprovementProposal,
    reason?: string,
  ): Promise<{ proposalId: string; claimId: string }> {
    const claimId = this.#claims.get(proposal.id)
    if (claimId === undefined) {
      throw new ActivationNotPermittedError(
        proposal.id,
        'no active activation to revert',
      )
    }
    await this.#memory.retract(
      claimId,
      reason ?? `learning proposal ${proposal.id} rolled back`,
    )
    await this.#store.append(
      LEARNING_STREAM_ID,
      [
        learningActivationRevertedEvent({
          proposalId: proposal.id,
          claimId,
          ...(reason === undefined ? {} : { reason }),
          revertedAt: this.#now(),
        }),
      ],
      {
        expectedSequence:
          (await this.#store.getLatestSequence(LEARNING_STREAM_ID)) + 1,
      },
    )
    this.#claims.delete(proposal.id)
    return { proposalId: proposal.id, claimId }
  }
}
