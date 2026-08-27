import { z } from 'zod'
import { ValidTimeSchema } from './envelope.ts'

/**
 * The personal memory domain and MemoryProvider contract (v1 refactor plan
 * §5.5 WF4-A, architecture §12.5). Memory is a projection over durable
 * facts: every claim carries provenance pointing at the Chronicle position
 * it was learned from, a valid-time interval, and an explicit status, so a
 * user can audit, correct, forget, and export what Bee Agent remembers.
 * Chronicle remains the source of truth — losing a memory provider never
 * loses the underlying thread facts.
 */

// ---------------------------------------------------------------------------
// Domain schemas
// ---------------------------------------------------------------------------

/** What a claim is about; `user` is the personal-preference subject. */
export const MemorySubjectSchema = z
  .object({
    type: z.enum(['user', 'project', 'topic', 'entity']),
    id: z.string().min(1).optional(),
  })
  .strict()
export type MemorySubject = z.infer<typeof MemorySubjectSchema>

export const MEMORY_CLAIM_KINDS = [
  'preference',
  'fact',
  'correction',
  'procedure',
] as const
export type MemoryClaimKind = (typeof MEMORY_CLAIM_KINDS)[number]
export const MemoryClaimKindSchema = z.enum(MEMORY_CLAIM_KINDS)

/** Where a memory fact was learned: one Chronicle stream position. */
export const MemoryProvenanceSchema = z
  .object({
    streamId: z.string().min(1),
    sequence: z.number().int().positive(),
    threadId: z.string().min(1).optional(),
    turnId: z.string().min(1).optional(),
    itemId: z.string().min(1).optional(),
  })
  .strict()
export type MemoryProvenance = z.infer<typeof MemoryProvenanceSchema>

export const MEMORY_CLAIM_STATUSES = [
  'active',
  'superseded',
  'retracted',
] as const
export type MemoryClaimStatus = (typeof MEMORY_CLAIM_STATUSES)[number]
export const MemoryClaimStatusSchema = z.enum(MEMORY_CLAIM_STATUSES)

export const MemoryClaimSchema = z
  .object({
    id: z.uuid(),
    kind: MemoryClaimKindSchema,
    statement: z.string().min(1),
    subject: MemorySubjectSchema,
    provenance: MemoryProvenanceSchema,
    validTime: ValidTimeSchema,
    confidence: z.number().min(0).max(1),
    status: MemoryClaimStatusSchema,
    /** Claim ids this one replaces (corrections, consolidation merges). */
    supersedes: z.array(z.uuid()),
    recordedAt: z.iso.datetime(),
  })
  .strict()
export type MemoryClaim = z.infer<typeof MemoryClaimSchema>

/** Raw evidence recorded before any derivation; kept for auditability. */
export const MemoryObservationSchema = z
  .object({
    id: z.uuid(),
    content: z.string().min(1),
    provenance: MemoryProvenanceSchema,
    observedAt: z.iso.datetime(),
    confidence: z.number().min(0).max(1),
  })
  .strict()
export type MemoryObservation = z.infer<typeof MemoryObservationSchema>

export const MEMORY_RENDERER_VERSION = 'bee-memory-text@1'

/** A deterministic re-renderable form over one or more claims. */
export const MemoryRepresentationSchema = z
  .object({
    id: z.uuid(),
    claimIds: z.array(z.uuid()).min(1),
    content: z.string().min(1),
    rendererVersion: z.literal(MEMORY_RENDERER_VERSION),
    tokens: z.number().int().nonnegative(),
  })
  .strict()
export type MemoryRepresentation = z.infer<typeof MemoryRepresentationSchema>

export const MemoryHealthSchema = z
  .object({
    status: z.enum(['healthy', 'degraded', 'unavailable']),
    detail: z.string().min(1).optional(),
  })
  .strict()
export type MemoryHealth = z.infer<typeof MemoryHealthSchema>

/** Same token convention as the context package (ceil of chars / 4). */
export function estimateMemoryTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// ---------------------------------------------------------------------------
// Provider-facing inputs
// ---------------------------------------------------------------------------

export interface NewMemoryClaimInput {
  readonly kind: MemoryClaimKind
  readonly statement: string
  readonly subject: MemorySubject
  readonly provenance: MemoryProvenance
  /** Defaults to `{ from: now }` — open-ended validity from the recording. */
  readonly validTime?: z.input<typeof ValidTimeSchema> | undefined
  /** Defaults to 1 (explicitly recorded); derived claims carry their own. */
  readonly confidence?: number | undefined
  readonly supersedes?: readonly string[] | undefined
  readonly id?: string | undefined
  readonly recordedAt?: string | undefined
}

export interface NewMemoryObservationInput {
  readonly content: string
  readonly provenance: MemoryProvenance
  readonly confidence?: number | undefined
  readonly id?: string | undefined
  readonly observedAt?: string | undefined
}

export interface MemoryIngestInput {
  readonly claims?: readonly NewMemoryClaimInput[] | undefined
  readonly observations?: readonly NewMemoryObservationInput[] | undefined
}

export interface MemoryIngestResult {
  readonly claims: readonly MemoryClaim[]
  readonly observations: readonly MemoryObservation[]
}

export interface MemoryQuery {
  readonly text: string
  readonly kinds?: readonly MemoryClaimKind[] | undefined
  readonly subjectType?: MemorySubject['type'] | undefined
  readonly limit?: number | undefined
  /** Valid-time evaluation point; defaults to the provider's clock. */
  readonly now?: string | undefined
}

export interface MemoryContextInput extends MemoryQuery {
  readonly budgetTokens: number
}

export interface MemoryContext {
  readonly content: string
  readonly claimIds: readonly string[]
  readonly tokens: number
  /** Claims that matched but did not fit the budget. */
  readonly omitted: number
}

export interface MemoryDerivationMessage {
  readonly role: 'user' | 'assistant' | 'tool'
  readonly content: string
  readonly provenance: MemoryProvenance
}

export interface MemoryDerivationInput {
  readonly threadId: string
  readonly turnId: string
  readonly messages: readonly MemoryDerivationMessage[]
  readonly now?: string | undefined
}

export interface MemoryDerivationResult {
  readonly claims: readonly NewMemoryClaimInput[]
  readonly observations: readonly NewMemoryObservationInput[]
}

export interface MemoryConsolidationReport {
  readonly considered: number
  readonly merged: readonly {
    readonly kept: string
    readonly superseded: readonly string[]
  }[]
  readonly at: string
}

export interface MemoryExport {
  readonly claims: readonly MemoryClaim[]
  readonly observations: readonly MemoryObservation[]
  readonly exportedAt: string
}

export class MemoryClaimNotFoundError extends Error {
  constructor(readonly claimId: string) {
    super(`Memory claim '${claimId}' was not found`)
    this.name = 'MemoryClaimNotFoundError'
  }
}

// ---------------------------------------------------------------------------
// The provider contract
// ---------------------------------------------------------------------------

/**
 * A personal memory provider (v1 refactor plan §5.5 WF4-A): the default
 * embedded implementation and any remote bridge implement the same seam.
 * Remote providers report degradation through {@link health} instead of
 * silently returning empty memories.
 */
export interface MemoryProvider {
  /** Records claims/observations; re-ingesting a known id is idempotent. */
  ingest(input: MemoryIngestInput): Promise<MemoryIngestResult>
  /** Active claims valid at `now`, ranked by lexical relevance. */
  query(query: MemoryQuery): Promise<readonly MemoryClaim[]>
  /** A budgeted context section; low-scoring claims are omitted first. */
  buildContext(input: MemoryContextInput): Promise<MemoryContext>
  /** Deterministic re-renderable form over the given claims. */
  getRepresentation(claimIds: readonly string[]): Promise<MemoryRepresentation>
  /**
   * Derives memory candidates from a completed turn's messages. Deliberately
   * deterministic baseline logic; callers ingest what they accept.
   */
  derive(input: MemoryDerivationInput): Promise<MemoryDerivationResult>
  /** Merges duplicate statements by superseding later recordings. */
  consolidate(): Promise<MemoryConsolidationReport>
  /** User-forgets a claim: durable retraction, kept in exports. */
  retract(claimId: string, reason?: string): Promise<MemoryClaim>
  /** Everything recorded, including superseded/retracted claims. */
  export(): Promise<MemoryExport>
  /** Availability for context injection; never silently empty. */
  health(): Promise<MemoryHealth>
}
