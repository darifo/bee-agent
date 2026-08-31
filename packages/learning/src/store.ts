import type {
  ChronicleEvent,
  ChronicleStore,
  NewChronicleEvent,
} from '@bee-agent/knowledge'
import {
  LEARNING_STREAM_ID,
  UnknownLearningEventTypeError,
  learningProposalCreatedEvent,
  learningProposalStatusChangedEvent,
} from './events.ts'
import {
  ImprovementProposalSchema,
  ProposalNotFoundError,
  ProposalVersionConflictError,
  canTransitionProposal,
  InvalidProposalTransitionError,
} from './proposal.ts'
import type {
  ImprovementProposal,
  ProposalStatus,
  ProposalType,
  AutonomyLevel,
} from './proposal.ts'

/**
 * The proposal store (WF5-B): a queryable projection over the `learning`
 * Chronicle stream, following the Kanban store pattern — every write
 * appends a durable event and advances the projection in one step, guarded
 * by `version` optimistic concurrency, and `rebuild()` recovers the full
 * board after a restart.
 */

export interface ProposalQuery {
  readonly status?: ProposalStatus | readonly ProposalStatus[] | undefined
  readonly type?: ProposalType | undefined
  readonly origin?: 'loop' | 'user' | undefined
  readonly autonomyLevel?: AutonomyLevel | undefined
  readonly limit?: number | undefined
}

export interface CreateProposalInput {
  readonly type: ProposalType
  readonly targetKey: string
  readonly targetVersion?: string | undefined
  readonly basedOnTrajectoryIds: readonly {
    readonly threadId: string
    readonly turnId: string
  }[]
  readonly hypothesis: string
  readonly proposedChange: unknown
  readonly expectedBenefits: readonly string[]
  readonly risks: readonly string[]
  readonly evaluationPlan: string
  readonly rollbackPlan: string
  readonly autonomyLevel: AutonomyLevel
  readonly origin?: 'loop' | 'user' | undefined
  readonly id?: string | undefined
  readonly now?: string | undefined
}

export class ChronicleProposalStore {
  readonly #chronicle: ChronicleStore
  readonly #proposals = new Map<string, ImprovementProposal>()

  constructor(chronicle: ChronicleStore) {
    this.#chronicle = chronicle
  }

  get(proposalId: string): Promise<ImprovementProposal | undefined> {
    return Promise.resolve(this.#proposals.get(proposalId))
  }

  async list(query: ProposalQuery = {}): Promise<ImprovementProposal[]> {
    let proposals = [...this.#proposals.values()]
    if (query.status !== undefined) {
      const statuses = new Set(
        Array.isArray(query.status) ? query.status : [query.status],
      )
      proposals = proposals.filter((p) => statuses.has(p.status))
    }
    if (query.type !== undefined) {
      proposals = proposals.filter((p) => p.type === query.type)
    }
    if (query.origin !== undefined) {
      proposals = proposals.filter((p) => p.origin === query.origin)
    }
    if (query.autonomyLevel !== undefined) {
      proposals = proposals.filter(
        (p) => p.autonomyLevel === query.autonomyLevel,
      )
    }
    proposals.sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    )
    return query.limit === undefined
      ? proposals
      : proposals.slice(0, query.limit)
  }

  async create(input: CreateProposalInput): Promise<ImprovementProposal> {
    const now = input.now ?? new Date().toISOString()
    const proposal = ImprovementProposalSchema.parse({
      id: input.id ?? crypto.randomUUID(),
      type: input.type,
      targetKey: input.targetKey,
      ...(input.targetVersion === undefined
        ? {}
        : { targetVersion: input.targetVersion }),
      basedOnTrajectoryIds: input.basedOnTrajectoryIds.map((ref) => ({
        threadId: ref.threadId,
        turnId: ref.turnId,
      })),
      hypothesis: input.hypothesis,
      proposedChange: input.proposedChange,
      expectedBenefits: [...input.expectedBenefits],
      risks: [...input.risks],
      evaluationPlan: input.evaluationPlan,
      rollbackPlan: input.rollbackPlan,
      autonomyLevel: input.autonomyLevel,
      status: 'draft',
      origin: input.origin ?? 'loop',
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    await this.#commit([learningProposalCreatedEvent(proposal)], proposal)
    return proposal
  }

  async transition(
    proposalId: string,
    command: {
      readonly to: ProposalStatus
      readonly expectedVersion: number
      readonly reason?: string | undefined
      readonly at?: string | undefined
    },
  ): Promise<ImprovementProposal> {
    const current = this.#proposals.get(proposalId)
    if (current === undefined) throw new ProposalNotFoundError(proposalId)
    if (command.expectedVersion !== current.version) {
      throw new ProposalVersionConflictError(
        proposalId,
        command.expectedVersion,
        current.version,
      )
    }
    if (!canTransitionProposal(current.status, command.to)) {
      throw new InvalidProposalTransitionError(
        proposalId,
        current.status,
        command.to,
      )
    }
    const at = command.at ?? new Date().toISOString()
    const next = ImprovementProposalSchema.parse({
      ...current,
      status: command.to,
      version: current.version + 1,
      updatedAt: at,
    })
    await this.#commit(
      [
        learningProposalStatusChangedEvent({
          proposalId,
          from: current.status,
          to: command.to,
          ...(command.reason !== undefined ? { reason: command.reason } : {}),
        }),
      ],
      next,
    )
    return next
  }

  /** True when an open proposal already targets the same key. */
  async hasOpenTarget(targetKey: string): Promise<boolean> {
    for (const proposal of this.#proposals.values()) {
      if (
        proposal.targetKey === targetKey &&
        (proposal.status === 'draft' ||
          proposal.status === 'testing' ||
          proposal.status === 'review' ||
          proposal.status === 'trial')
      ) {
        return true
      }
    }
    return false
  }

  /** Replays the learning stream into the projection (restart recovery). */
  async rebuild(): Promise<void> {
    this.#proposals.clear()
    for await (const event of this.#chronicle.readStream(LEARNING_STREAM_ID)) {
      this.#fold(event)
    }
  }

  async #commit(
    events: readonly NewChronicleEvent[],
    next: ImprovementProposal,
  ): Promise<void> {
    const expected =
      (await this.#chronicle.getLatestSequence(LEARNING_STREAM_ID)) + 1
    await this.#chronicle.append(LEARNING_STREAM_ID, events, {
      expectedSequence: expected,
    })
    this.#proposals.set(next.id, next)
  }

  #fold(event: ChronicleEvent): void {
    switch (event.eventType) {
      case 'learning.proposal.created': {
        const { proposal } = event.payload as {
          proposal: ImprovementProposal
        }
        this.#proposals.set(proposal.id, proposal)
        return
      }
      case 'learning.proposal.status_changed': {
        const payload = event.payload as {
          proposalId: string
          to: ProposalStatus
        }
        const proposal = this.#proposals.get(payload.proposalId)
        if (proposal === undefined) return
        this.#proposals.set(proposal.id, {
          ...proposal,
          status: payload.to,
          version: proposal.version + 1,
          updatedAt: event.ingestTime,
        })
        return
      }
      case 'learning.loop.run':
      case 'learning.experiment.started':
      case 'learning.experiment.completed':
      case 'learning.experiment.failed':
      case 'learning.proposal.activated':
      case 'learning.proposal.activation-reverted':
        return
      default:
        throw new UnknownLearningEventTypeError(event.eventType)
    }
  }
}
