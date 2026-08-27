import type {
  ChronicleStore,
  MemoryClaim,
  MemoryContext,
  MemoryContextInput,
  MemoryConsolidationReport,
  MemoryDerivationInput,
  MemoryDerivationResult,
  MemoryExport,
  MemoryHealth,
  MemoryIngestInput,
  MemoryIngestResult,
  MemoryObservation,
  MemoryProvider,
  MemoryQuery,
  MemoryRepresentation,
  NewChronicleEvent,
} from '@bee-agent/knowledge'
import {
  ChronicleSequenceConflictError,
  MEMORY_RENDERER_VERSION,
  MemoryClaimNotFoundError,
  MemoryClaimSchema,
  MemoryObservationSchema,
  estimateMemoryTokens,
  memoryClaimRecordedEvent,
  memoryClaimRetractedEvent,
  memoryClaimSupersededEvent,
  memoryConsolidationCompletedEvent,
  memoryObservationRecordedEvent,
  memoryStreamId,
  UnknownMemoryEventTypeError,
} from '@bee-agent/knowledge'
import { deriveClaimCandidates, normalizeStatement } from './memory-deriver.ts'

/**
 * The default embedded memory provider (v1 refactor plan §5.5 WF4-B,
 * architecture §12.5): an in-memory projection over the serialized `memory`
 * Chronicle stream. Every mutation appends a durable event first and advances
 * the projection second, so `rebuild()` restores the full state after a Host
 * restart and Chronicle stays the source of truth. Lexical search (English
 * words + CJK bigrams) keeps recall local and deterministic — no embedding
 * service required.
 */

export interface EmbeddedMemoryOptions {
  readonly store: ChronicleStore
  readonly now?: (() => string) | undefined
}

const DEFAULT_QUERY_LIMIT = 8

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'do',
  'does',
  'did',
  'i',
  'you',
  'we',
  'it',
  'in',
  'on',
  'of',
  'to',
  'and',
  'or',
  'for',
  'with',
  'that',
  'this',
  'please',
  'from',
  'be',
  'my',
  'me',
  'at',
  'as',
  'by',
])

const CJK_PATTERN = /^\p{Script=Han}+$/u

/** English words plus CJK single chars and bigrams, lowercased. */
export function tokenizeMemoryText(text: string): string[] {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const terms: string[] = []
  for (const token of tokens) {
    if (CJK_PATTERN.test(token)) {
      for (const char of token) terms.push(char)
      for (let i = 0; i + 1 < token.length; i += 1) {
        terms.push(token.slice(i, i + 2))
      }
    } else if (!STOPWORDS.has(token)) {
      terms.push(token)
    }
  }
  return terms
}

function isValidAt(claim: MemoryClaim, now: string): boolean {
  if (claim.validTime.from > now) return false
  return claim.validTime.to === undefined || claim.validTime.to > now
}

function renderClaimLine(claim: MemoryClaim): string {
  return `[${claim.kind}] ${claim.statement}`
}

export class EmbeddedMemoryProvider implements MemoryProvider {
  readonly #store: ChronicleStore
  readonly #now: () => string
  readonly #claims = new Map<string, MemoryClaim>()
  readonly #observations = new Map<string, MemoryObservation>()
  readonly #order: string[] = []
  readonly #terms = new Map<string, Set<string>>()
  #tail: Promise<unknown> = Promise.resolve()

  constructor(options: EmbeddedMemoryOptions) {
    this.#store = options.store
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  // -----------------------------------------------------------------------
  // Ingest
  // -----------------------------------------------------------------------

  ingest(input: MemoryIngestInput): Promise<MemoryIngestResult> {
    return this.#serialize(() => this.#ingestNow(input))
  }

  async #ingestNow(input: MemoryIngestInput): Promise<MemoryIngestResult> {
    const events: NewChronicleEvent[] = []
    const claims: MemoryClaim[] = []
    const observations: MemoryObservation[] = []
    const now = this.#now()

    for (const candidate of input.claims ?? []) {
      const existing =
        candidate.id === undefined ? undefined : this.#claims.get(candidate.id)
      if (existing !== undefined) {
        claims.push(existing)
        continue
      }
      const claim = MemoryClaimSchema.parse({
        id: candidate.id ?? crypto.randomUUID(),
        kind: candidate.kind,
        statement: candidate.statement,
        subject: candidate.subject,
        provenance: candidate.provenance,
        validTime: candidate.validTime ?? { from: now },
        confidence: candidate.confidence ?? 1,
        status: 'active',
        supersedes: [...(candidate.supersedes ?? [])],
        recordedAt: candidate.recordedAt ?? now,
      })
      for (const supersededId of claim.supersedes) {
        const target = this.#claims.get(supersededId)
        if (target === undefined) {
          throw new MemoryClaimNotFoundError(supersededId)
        }
        if (target.status !== 'active') continue
        events.push(
          memoryClaimSupersededEvent({
            claimId: target.id,
            supersededBy: claim.id,
            reason: 'superseded by correction',
          }),
        )
      }
      events.push(memoryClaimRecordedEvent(claim))
      claims.push(claim)
    }

    for (const candidate of input.observations ?? []) {
      const existing =
        candidate.id === undefined
          ? undefined
          : this.#observations.get(candidate.id)
      if (existing !== undefined) {
        observations.push(existing)
        continue
      }
      const observation = MemoryObservationSchema.parse({
        id: candidate.id ?? crypto.randomUUID(),
        content: candidate.content,
        provenance: candidate.provenance,
        observedAt: candidate.observedAt ?? now,
        confidence: candidate.confidence ?? 1,
      })
      events.push(memoryObservationRecordedEvent(observation))
      observations.push(observation)
    }

    await this.#append(events)
    // Apply after the durable append so a failed write never mutates state.
    for (const event of events) this.#fold(event)
    return { claims, observations }
  }

  // -----------------------------------------------------------------------
  // Query and context
  // -----------------------------------------------------------------------

  async query(query: MemoryQuery): Promise<readonly MemoryClaim[]> {
    const now = query.now ?? this.#now()
    const eligible = [...this.#claims.values()].filter(
      (claim) =>
        claim.status === 'active' &&
        isValidAt(claim, now) &&
        (query.kinds === undefined || query.kinds.includes(claim.kind)) &&
        (query.subjectType === undefined ||
          claim.subject.type === query.subjectType),
    )
    const limit = query.limit ?? DEFAULT_QUERY_LIMIT
    const queryTerms = new Set(tokenizeMemoryText(query.text))

    if (queryTerms.size === 0) {
      return this.#mostRecent(eligible, limit)
    }
    const scored = eligible
      .map((claim) => {
        const claimTerms = this.#terms.get(claim.id) ?? new Set<string>()
        let score = 0
        for (const term of queryTerms) {
          if (claimTerms.has(term)) score += 1
        }
        return { claim, score }
      })
      .filter((entry) => entry.score > 0)
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        b.claim.recordedAt.localeCompare(a.claim.recordedAt) ||
        a.claim.id.localeCompare(b.claim.id),
    )
    return scored.slice(0, limit).map((entry) => entry.claim)
  }

  async buildContext(input: MemoryContextInput): Promise<MemoryContext> {
    const claims = await this.query(input)
    const lines = claims.map(renderClaimLine)
    const included: string[] = []
    const claimIds: string[] = []
    let tokens = 0
    let omitted = 0
    for (let i = 0; i < claims.length; i += 1) {
      const candidate = [...included, lines[i]!].join('\n')
      const candidateTokens = estimateMemoryTokens(candidate)
      if (candidateTokens > input.budgetTokens) {
        omitted += 1
        continue
      }
      included.push(lines[i]!)
      claimIds.push(claims[i]!.id)
      tokens = candidateTokens
    }
    return { content: included.join('\n'), claimIds, tokens, omitted }
  }

  async getRepresentation(
    claimIds: readonly string[],
  ): Promise<MemoryRepresentation> {
    if (claimIds.length === 0) {
      throw new Error('getRepresentation requires at least one claim id')
    }
    const claims = [...claimIds].sort().map((claimId) => {
      const claim = this.#claims.get(claimId)
      if (claim === undefined) throw new MemoryClaimNotFoundError(claimId)
      return claim
    })
    const content = claims.map(renderClaimLine).join('\n')
    return {
      id: crypto.randomUUID(),
      claimIds: [...claimIds].sort(),
      content,
      rendererVersion: MEMORY_RENDERER_VERSION,
      tokens: estimateMemoryTokens(content),
    }
  }

  // -----------------------------------------------------------------------
  // Derive, consolidate, retract
  // -----------------------------------------------------------------------

  async derive(input: MemoryDerivationInput): Promise<MemoryDerivationResult> {
    const active = [...this.#claims.values()].filter(
      (claim) => claim.status === 'active',
    )
    return deriveClaimCandidates(input.messages, { activeClaims: active })
  }

  consolidate(): Promise<MemoryConsolidationReport> {
    return this.#serialize(() => this.#consolidateNow())
  }

  async #consolidateNow(): Promise<MemoryConsolidationReport> {
    const now = this.#now()
    const groups = new Map<string, MemoryClaim[]>()
    for (const claim of this.#claims.values()) {
      if (claim.status !== 'active') continue
      const key = [
        claim.kind,
        claim.subject.type,
        claim.subject.id ?? '',
        normalizeStatement(claim.statement),
      ].join('|')
      const group = groups.get(key) ?? []
      group.push(claim)
      groups.set(key, group)
    }

    const merged: MemoryConsolidationReport['merged'][number][] = []
    const events: NewChronicleEvent[] = []
    for (const group of groups.values()) {
      if (group.length < 2) continue
      const sorted = [...group].sort(
        (a, b) =>
          a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id),
      )
      const kept = sorted[0]!
      const superseded = sorted.slice(1)
      for (const duplicate of superseded) {
        events.push(
          memoryClaimSupersededEvent({
            claimId: duplicate.id,
            supersededBy: kept.id,
            reason: 'consolidation merged a duplicate statement',
          }),
        )
      }
      merged.push({ kept: kept.id, superseded: superseded.map((c) => c.id) })
    }

    const considered = [...this.#claims.values()].filter(
      (claim) => claim.status === 'active',
    ).length
    const report: MemoryConsolidationReport = { considered, merged, at: now }
    if (events.length > 0) {
      events.push(memoryConsolidationCompletedEvent(report))
      await this.#append(events)
      for (const event of events) this.#fold(event)
    }
    return report
  }

  retract(claimId: string, reason?: string): Promise<MemoryClaim> {
    return this.#serialize(() => this.#retractNow(claimId, reason))
  }

  async #retractNow(
    claimId: string,
    reason: string | undefined,
  ): Promise<MemoryClaim> {
    const claim = this.#claims.get(claimId)
    if (claim === undefined) throw new MemoryClaimNotFoundError(claimId)
    const event = memoryClaimRetractedEvent({
      claimId,
      ...(reason !== undefined ? { reason } : {}),
    })
    await this.#append([event])
    this.#fold(event)
    return this.#claims.get(claimId)!
  }

  // -----------------------------------------------------------------------
  // Export, health, rebuild
  // -----------------------------------------------------------------------

  async export(): Promise<MemoryExport> {
    return {
      claims: this.#order.flatMap((id) => {
        const claim = this.#claims.get(id)
        return claim === undefined ? [] : [claim]
      }),
      observations: [...this.#observations.values()],
      exportedAt: this.#now(),
    }
  }

  async health(): Promise<MemoryHealth> {
    return { status: 'healthy' }
  }

  /** Replays the memory stream into the projection (restart recovery). */
  async rebuild(): Promise<void> {
    return this.#serialize(async () => {
      this.#claims.clear()
      this.#observations.clear()
      this.#order.length = 0
      this.#terms.clear()
      for await (const event of this.#store.readStream(memoryStreamId())) {
        this.#fold(event as NewChronicleEvent)
      }
    })
  }

  // -----------------------------------------------------------------------
  // Projection internals
  // -----------------------------------------------------------------------

  #fold(event: NewChronicleEvent | { eventType: string; payload: unknown }) {
    switch (event.eventType) {
      case 'memory.claim.recorded': {
        const { claim } = event.payload as { claim: MemoryClaim }
        if (!this.#claims.has(claim.id)) this.#order.push(claim.id)
        this.#claims.set(claim.id, claim)
        this.#terms.set(
          claim.id,
          new Set([
            ...tokenizeMemoryText(claim.statement),
            ...tokenizeMemoryText(claim.kind),
          ]),
        )
        return
      }
      case 'memory.claim.superseded': {
        const { claimId } = event.payload as { claimId: string }
        const claim = this.#claims.get(claimId)
        if (claim !== undefined && claim.status === 'active') {
          this.#claims.set(claimId, { ...claim, status: 'superseded' })
        }
        return
      }
      case 'memory.claim.retracted': {
        const { claimId } = event.payload as { claimId: string }
        const claim = this.#claims.get(claimId)
        if (claim !== undefined) {
          this.#claims.set(claimId, { ...claim, status: 'retracted' })
        }
        return
      }
      case 'memory.observation.recorded': {
        const { observation } = event.payload as {
          observation: MemoryObservation
        }
        this.#observations.set(observation.id, observation)
        return
      }
      case 'memory.consolidation.completed':
        return
      default:
        throw new UnknownMemoryEventTypeError(event.eventType)
    }
  }

  #mostRecent(claims: readonly MemoryClaim[], limit: number): MemoryClaim[] {
    return [...claims]
      .sort(
        (a, b) =>
          b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id),
      )
      .slice(0, limit)
  }

  /** Serialized append with bounded retry on concurrent sequence conflicts. */
  async #append(events: readonly NewChronicleEvent[]): Promise<void> {
    if (events.length === 0) return
    for (let attempt = 0; ; attempt += 1) {
      const expected =
        (await this.#store.getLatestSequence(memoryStreamId())) + 1
      try {
        await this.#store.append(memoryStreamId(), events, {
          expectedSequence: expected,
        })
        return
      } catch (error) {
        if (error instanceof ChronicleSequenceConflictError && attempt < 2) {
          continue
        }
        throw error
      }
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(operation, operation)
    this.#tail = run.catch(() => undefined)
    return run
  }
}
