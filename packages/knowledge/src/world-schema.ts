import { z } from 'zod'
import { ValidTimeSchema } from './envelope.ts'

/**
 * World domain schemas (architecture §7.2, v1 refactor plan §5.5 WF4-D),
 * isolated from both the event builders and the projection store so the
 * module graph stays acyclic.
 */

export const WORLD_ENTITY_KINDS = [
  'actor',
  'resource',
  'capability',
  'location',
] as const
export type WorldEntityKind = (typeof WORLD_ENTITY_KINDS)[number]
export const WorldEntityKindSchema = z.enum(WORLD_ENTITY_KINDS)

const WorldAttributeSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
])
export type WorldAttributeValue = z.infer<typeof WorldAttributeSchema>

export const WorldEntitySchema = z
  .object({
    id: z.string().min(1),
    kind: WorldEntityKindSchema,
    subtype: z.string().min(1).optional(),
    attributes: z.record(z.string(), WorldAttributeSchema),
    firstSeenAt: z.iso.datetime(),
    lastSeenAt: z.iso.datetime(),
  })
  .strict()
export type WorldEntity = z.infer<typeof WorldEntitySchema>

export interface NewWorldEntityInput {
  readonly id: string
  readonly kind: WorldEntityKind
  readonly subtype?: string | undefined
  readonly attributes?:
    Readonly<Record<string, WorldAttributeValue>> | undefined
  /** Defaults to the store's clock. */
  readonly seenAt?: string | undefined
}

/** Where a world fact was learned: one Chronicle stream position. */
export const WorldProvenanceSchema = z
  .object({
    streamId: z.string().min(1),
    sequence: z.number().int().positive(),
    threadId: z.string().min(1).optional(),
    turnId: z.string().min(1).optional(),
    itemId: z.string().min(1).optional(),
  })
  .strict()
export type WorldProvenance = z.infer<typeof WorldProvenanceSchema>

/**
 * Relation types from architecture §7.2 plus `used`, which records an
 * observed usage episode (who used which capability, and when).
 */
export const WORLD_RELATION_TYPES = [
  'owns',
  'depends_on',
  'contains',
  'connected_to',
  'authorized_for',
  'produced_by',
  'used',
] as const
export type WorldRelationType = (typeof WORLD_RELATION_TYPES)[number]
export const WorldRelationTypeSchema = z.enum(WORLD_RELATION_TYPES)

export const WorldRelationSchema = z
  .object({
    id: z.uuid(),
    type: WorldRelationTypeSchema,
    fromEntityId: z.string().min(1),
    toEntityId: z.string().min(1),
    provenance: WorldProvenanceSchema,
    validTime: ValidTimeSchema,
    recordedAt: z.iso.datetime(),
  })
  .strict()
export type WorldRelation = z.infer<typeof WorldRelationSchema>

export interface NewWorldRelationInput {
  readonly type: WorldRelationType
  readonly fromEntityId: string
  readonly toEntityId: string
  readonly provenance: WorldProvenance
  /** Defaults to `{ from: recordedAt }` — open-ended from the recording. */
  readonly validTime?: z.input<typeof ValidTimeSchema> | undefined
  readonly id?: string | undefined
  readonly recordedAt?: string | undefined
}

export const WorldVersionSchema = z
  .object({
    version: z.number().int().positive(),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    at: z.iso.datetime(),
  })
  .strict()
export type WorldVersion = z.infer<typeof WorldVersionSchema>

export interface WorldSnapshot {
  readonly version: number
  readonly digest: string
  readonly entities: readonly WorldEntity[]
  readonly relations: readonly WorldRelation[]
}

/** One projector's derived facts for a single source event. */
export interface WorldProjectionInput {
  readonly entities?: readonly NewWorldEntityInput[] | undefined
  readonly relations?: readonly NewWorldRelationInput[] | undefined
}

export class WorldVersionDriftError extends Error {
  constructor(
    readonly version: number,
    readonly expectedDigest: string,
    readonly actualDigest: string,
  ) {
    super(
      `World version ${version} replayed to ${actualDigest}, expected ${expectedDigest}`,
    )
    this.name = 'WorldVersionDriftError'
  }
}
