import { z } from 'zod'
import { newChronicleEvent } from '@bee-agent/knowledge'
import type { ChronicleActor, NewChronicleEvent } from '@bee-agent/knowledge'
import type { ChronicleSchemaRegistry } from '@bee-agent/knowledge'

/**
 * Durable skills (architecture §12): a promoted learning proposal can
 * activate as a structured skill — instructions plus the bound tool the
 * model should prefer for the matched task. The `skills` stream is the
 * single source of truth; the latest fact per skill id wins, so a revoke
 * is a fact, not a deletion.
 */

export const SKILLS_STREAM_ID = 'skills'

export function skillsStreamId(): string {
  return SKILLS_STREAM_ID
}

export const SKILL_EVENT_TYPES = ['skill.registered', 'skill.revoked'] as const
export type SkillEventType = (typeof SKILL_EVENT_TYPES)[number]

/** A promoted proposal carries its derivation lineage. */
export const SkillProposalOriginSchema = z.object({
  proposalId: z.string().min(1),
  targetKey: z.string().min(1),
})
export type SkillProposalOrigin = z.infer<typeof SkillProposalOriginSchema>

const SkillRegisteredPayloadSchema = z.object({
  skillId: z.string().min(1),
  name: z.string().min(1),
  summary: z.string().min(1),
  /** Step-by-step instructions the model loads when it runs the skill. */
  instructions: z.string().min(1),
  /** The concrete tool this skill wraps; skill_run executes through it. */
  boundToolId: z.string().min(1),
  /** Typical arguments snapshot — a starting point, model-adjustable. */
  typicalInput: z.record(z.string(), z.unknown()),
  origin: SkillProposalOriginSchema,
  registeredBy: z.string().min(1),
  registeredAt: z.iso.datetime(),
})

const SkillRevokedPayloadSchema = z.object({
  skillId: z.string().min(1),
  reason: z.string().min(1).optional(),
  registeredBy: z.string().min(1),
  registeredAt: z.iso.datetime(),
})

const SKILL_EVENT_PAYLOADS: Record<SkillEventType, z.ZodType<unknown>> = {
  'skill.registered': SkillRegisteredPayloadSchema,
  'skill.revoked': SkillRevokedPayloadSchema,
}

export class UnknownSkillEventTypeError extends Error {
  constructor(readonly eventType: string) {
    super(`Event type '${eventType}' is not a skill event`)
    this.name = 'UnknownSkillEventTypeError'
  }
}

export function registerSkillChronicleEvents(
  registry: ChronicleSchemaRegistry,
): void {
  for (const [eventType, payload] of Object.entries(SKILL_EVENT_PAYLOADS)) {
    registry.register(eventType, { payload: payload as never })
  }
}

const SKILL_ACTOR: ChronicleActor = { type: 'system', id: 'bee-skills' }

export interface SkillEventBuildOptions {
  readonly actor?: ChronicleActor | undefined
}

export function skillRegisteredEvent(
  input: z.infer<typeof SkillRegisteredPayloadSchema>,
  options: SkillEventBuildOptions = {},
): NewChronicleEvent {
  return newChronicleEvent({
    eventType: 'skill.registered',
    actor: options.actor ?? SKILL_ACTOR,
    payload: SkillRegisteredPayloadSchema.parse(input),
  })
}

export function skillRevokedEvent(
  input: z.infer<typeof SkillRevokedPayloadSchema>,
  options: SkillEventBuildOptions = {},
): NewChronicleEvent {
  return newChronicleEvent({
    eventType: 'skill.revoked',
    actor: options.actor ?? SKILL_ACTOR,
    payload: SkillRevokedPayloadSchema.parse(input),
  })
}

/** A live skill as the registry and the model-facing tool see it. */
export interface StoredSkill {
  readonly skillId: string
  readonly name: string
  readonly summary: string
  readonly instructions: string
  readonly boundToolId: string
  readonly typicalInput: Record<string, unknown>
  readonly origin: SkillProposalOrigin
  readonly registeredAt: string
}
