import type { ChronicleStore } from '@bee-agent/knowledge'
import {
  SKILLS_STREAM_ID,
  skillRegisteredEvent,
  skillRevokedEvent,
} from '@bee-agent/execution'
import type { StoredSkill } from '@bee-agent/execution'

/**
 * Durable skill registry over the `skills` stream: latest fact per skill
 * id wins. The `skills` map instance is stable for the host's lifetime,
 * so tool specs derived from it see new registrations without a rebuild.
 */
export class SkillStore {
  readonly #store: ChronicleStore
  readonly #skills = new Map<string, StoredSkill>()

  constructor(store: ChronicleStore) {
    this.#store = store
  }

  get skills(): ReadonlyMap<string, StoredSkill> {
    return this.#skills
  }

  list(): readonly StoredSkill[] {
    return [...this.#skills.values()].sort((a, b) =>
      a.skillId.localeCompare(b.skillId),
    )
  }

  get(skillId: string): StoredSkill | undefined {
    return this.#skills.get(skillId)
  }

  /** Replays the skills stream; the latest fact per id wins. */
  async rebuild(): Promise<void> {
    this.#skills.clear()
    for await (const event of this.#store.readStream(SKILLS_STREAM_ID)) {
      const payload = event.payload as {
        skillId?: unknown
        name?: unknown
        summary?: unknown
        instructions?: unknown
        boundToolId?: unknown
        typicalInput?: unknown
        origin?: unknown
        registeredBy?: unknown
        registeredAt?: unknown
        reason?: unknown
      }
      if (typeof payload.skillId !== 'string') continue
      if (event.eventType === 'skill.registered') {
        if (
          typeof payload.name !== 'string' ||
          typeof payload.summary !== 'string' ||
          typeof payload.instructions !== 'string' ||
          typeof payload.boundToolId !== 'string' ||
          payload.typicalInput === undefined ||
          typeof payload.origin !== 'object' ||
          payload.origin === null
        ) {
          continue
        }
        this.#skills.set(payload.skillId, {
          skillId: payload.skillId,
          name: payload.name,
          summary: payload.summary,
          instructions: payload.instructions,
          boundToolId: payload.boundToolId,
          typicalInput: payload.typicalInput as Record<string, unknown>,
          origin: payload.origin as StoredSkill['origin'],
          registeredAt:
            typeof payload.registeredAt === 'string'
              ? payload.registeredAt
              : event.eventTime,
        })
      } else if (event.eventType === 'skill.revoked') {
        this.#skills.delete(payload.skillId)
      }
    }
  }

  async register(skill: {
    readonly skillId: string
    readonly name: string
    readonly summary: string
    readonly instructions: string
    readonly boundToolId: string
    readonly typicalInput: Record<string, unknown>
    readonly origin: StoredSkill['origin']
    readonly registeredBy?: string | undefined
  }): Promise<void> {
    const registeredAt = new Date().toISOString()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const expectedSequence =
        (await this.#store.getLatestSequence(SKILLS_STREAM_ID)) + 1
      try {
        await this.#store.append(
          SKILLS_STREAM_ID,
          [
            skillRegisteredEvent({
              ...skill,
              registeredBy: skill.registeredBy ?? 'user',
              registeredAt,
            }),
          ],
          { expectedSequence },
        )
        break
      } catch (error) {
        // Sequence conflicts mean a concurrent writer moved the tail:
        // retry from the new position. Anything else is a real fault —
        // an unregistered event type must not be swallowed.
        if (
          attempt === 1 ||
          !(error instanceof Object) ||
          !('name' in error) ||
          (error as { name?: string }).name !== 'ChronicleSequenceConflictError'
        ) {
          throw error
        }
      }
    }
    await this.rebuild()
  }

  async revoke(skillId: string, reason?: string): Promise<void> {
    const registeredAt = new Date().toISOString()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const expectedSequence =
        (await this.#store.getLatestSequence(SKILLS_STREAM_ID)) + 1
      try {
        await this.#store.append(
          SKILLS_STREAM_ID,
          [
            skillRevokedEvent({
              skillId,
              reason,
              registeredBy: 'user',
              registeredAt,
            }),
          ],
          { expectedSequence },
        )
        break
      } catch (error) {
        if (
          attempt === 1 ||
          !(error instanceof Object) ||
          !('name' in error) ||
          (error as { name?: string }).name !== 'ChronicleSequenceConflictError'
        ) {
          throw error
        }
      }
    }
    await this.rebuild()
  }
}
