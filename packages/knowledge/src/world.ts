import { createHash } from 'node:crypto'
import { canonicalJson } from '@bee-agent/kernel'
import type { ChronicleStore } from './chronicle-store.ts'
import { ChronicleSequenceConflictError } from './chronicle-store.ts'
import type { NewChronicleEvent } from './envelope.ts'
import {
  WorldEntitySchema,
  WorldRelationSchema,
  WorldVersionDriftError,
  WorldVersionSchema,
} from './world-schema.ts'
import type {
  NewWorldEntityInput,
  WorldEntity,
  WorldProjectionInput,
  WorldRelation,
  WorldRelationType,
  WorldEntityKind,
  WorldSnapshot,
} from './world-schema.ts'
import {
  WORLD_STREAM_ID,
  UnknownWorldEventTypeError,
  worldEntityRecordedEvent,
  worldRelationProjectedEvent,
  worldVersionBumpedEvent,
} from './world-events.ts'

/**
 * The world projection store (architecture §7.2, v1 refactor plan §5.5
 * WF4-D): {@link WorldModelStore.record} appends durable world events and
 * advances the projection in one step, bumping the version with a digest of
 * the resulting state; {@link WorldModelStore.rebuild} replays the `world`
 * stream and verifies every recorded digest, so restarts recover exactly the
 * same world or fail loud. The WorldModel never accepts unevidenced input:
 * every relation carries provenance citing its source Chronicle position.
 */

function mergeEntity(
  existing: WorldEntity | undefined,
  input: NewWorldEntityInput,
  seenAt: string,
): WorldEntity {
  if (existing === undefined) {
    return WorldEntitySchema.parse({
      id: input.id,
      kind: input.kind,
      ...(input.subtype === undefined ? {} : { subtype: input.subtype }),
      attributes: { ...(input.attributes ?? {}) },
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
    })
  }
  return WorldEntitySchema.parse({
    ...existing,
    lastSeenAt: seenAt,
    attributes: { ...existing.attributes, ...(input.attributes ?? {}) },
  })
}

function computeWorldDigest(state: {
  entities: Map<string, WorldEntity>
  relations: Map<string, WorldRelation>
}): string {
  const canonical = {
    entities: [...state.entities.values()]
      .map((entity) => ({
        ...entity,
        attributes: Object.fromEntries(
          Object.entries(entity.attributes).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        ),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    relations: [...state.relations.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
  }
  return `sha256:${createHash('sha256')
    .update(canonicalJson(canonical))
    .digest('hex')}`
}

const EMPTY_DIGEST = computeWorldDigest({
  entities: new Map(),
  relations: new Map(),
})

export interface WorldModelStoreOptions {
  readonly store: ChronicleStore
  readonly now?: (() => string) | undefined
}

export class WorldModelStore {
  readonly #chronicle: ChronicleStore
  readonly #now: () => string
  readonly #entities = new Map<string, WorldEntity>()
  readonly #relations = new Map<string, WorldRelation>()
  #version = 0
  #digest = EMPTY_DIGEST
  #skipDigestChecks = false
  #driftNotice:
    | { readonly detectedAtVersion: number; readonly rebasedToVersion: number }
    | undefined
  #tail: Promise<unknown> = Promise.resolve()

  constructor(options: WorldModelStoreOptions) {
    this.#chronicle = options.store
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  /** Records projected entities/relations and bumps the world version. */
  record(input: WorldProjectionInput): Promise<WorldSnapshot> {
    return this.#serialize(() => this.#recordNow(input))
  }

  /**
   * Rebuild policy on a digest mismatch: `fail` keeps the strict replay
   * contract; `rebase` treats the event stream as the truth, finishes the
   * fold, and appends a corrective version bump carrying the replayed
   * digest — a historical write defect then costs one warning instead of
   * blocking every startup forever.
   */
  async rebuild(
    options: {
      readonly onDrift?: 'fail' | 'rebase' | undefined
    } = {},
  ): Promise<void> {
    const policy = options.onDrift ?? 'fail'
    return this.#serialize(async () => {
      this.#entities.clear()
      this.#relations.clear()
      this.#version = 0
      this.#digest = EMPTY_DIGEST
      let driftedAt: number | undefined
      let lastBumpDigest: string | undefined
      // One mismatched bump may be followed by a corrective one whose
      // digest matches the folded state (a prior rebase) — that pair is
      // healthy. A second consecutive mismatch is a real drift.
      let pendingBad: { version: number; expected: string } | undefined
      for await (const event of this.#chronicle.readStream(WORLD_STREAM_ID)) {
        if (event.eventType === 'world.version.bumped') {
          const bump = WorldVersionSchema.parse(event.payload)
          lastBumpDigest = bump.digest
          const actual = this.computeDigest()
          if (actual === bump.digest) {
            this.#version = bump.version
            this.#digest = bump.digest
            pendingBad = undefined
            continue
          }
          if (pendingBad === undefined) {
            pendingBad = { version: bump.version, expected: bump.digest }
            continue
          }
          if (policy === 'fail') {
            throw new WorldVersionDriftError(
              pendingBad.version,
              pendingBad.expected,
              actual,
            )
          }
          // Once drifted, the stored digests are a broken reference: keep
          // folding events (the truth) and skip further verification.
          driftedAt = pendingBad.version
          this.#version = Math.max(this.#version, bump.version)
          pendingBad = undefined
          this.#skipDigestChecks = true
          continue
        }
        if (
          this.#skipDigestChecks &&
          event.eventType === 'world.version.bumped'
        ) {
          continue
        }
        this.#fold(event.eventType, event.payload)
      }
      this.#skipDigestChecks = false
      // A trailing uncorrected bad bump: fail keeps the strict contract;
      // rebase appends the corrective fact (idempotently — a stream that
      // already ends on the replayed digest appends nothing).
      if (pendingBad !== undefined) {
        if (policy === 'fail') {
          throw new WorldVersionDriftError(
            pendingBad.version,
            pendingBad.expected,
            this.computeDigest(),
          )
        }
        driftedAt = pendingBad.version
      }
      if (driftedAt !== undefined && lastBumpDigest !== this.computeDigest()) {
        const corrective =
          Math.max(this.#version, driftedAt + 1, pendingBad?.version ?? 0) + 1
        const digest = this.computeDigest()
        await this.#append([
          worldVersionBumpedEvent({
            version: corrective,
            digest,
            at: this.#now(),
          }),
        ])
        this.#version = corrective
        this.#digest = digest
        this.#driftNotice = {
          detectedAtVersion: driftedAt,
          rebasedToVersion: corrective,
        }
      } else if (driftedAt !== undefined) {
        this.#digest = this.computeDigest()
        this.#driftNotice = {
          detectedAtVersion: driftedAt,
          rebasedToVersion: this.#version,
        }
      }
    })
  }

  /** The digest of the current in-memory projection. */
  computeDigest(): string {
    return computeWorldDigest({
      entities: this.#entities,
      relations: this.#relations,
    })
  }

  /** Set when a rebuild rebased over a historical digest drift. */
  get driftNotice():
    | { readonly detectedAtVersion: number; readonly rebasedToVersion: number }
    | undefined {
    return this.#driftNotice
  }

  async #recordNow(input: WorldProjectionInput): Promise<WorldSnapshot> {
    const now = this.#now()
    const entities = input.entities ?? []
    const relations = input.relations ?? []
    if (entities.length === 0 && relations.length === 0) {
      return this.snapshot()
    }

    // Fold against shadow copies first to compute the next digest; the
    // appended events then carry the authoritative recorded forms.
    const nextEntities = new Map(this.#entities)
    for (const entity of entities) {
      nextEntities.set(
        entity.id,
        mergeEntity(nextEntities.get(entity.id), entity, entity.seenAt ?? now),
      )
    }
    const nextRelations = new Map(this.#relations)
    const relationIds: string[] = []
    for (const relation of relations) {
      const id = relation.id ?? crypto.randomUUID()
      relationIds.push(id)
      nextRelations.set(
        id,
        WorldRelationSchema.parse({
          id,
          type: relation.type,
          fromEntityId: relation.fromEntityId,
          toEntityId: relation.toEntityId,
          provenance: relation.provenance,
          validTime: relation.validTime ?? { from: relation.recordedAt ?? now },
          recordedAt: relation.recordedAt ?? now,
        }),
      )
    }
    const nextVersion = this.#version + 1
    const nextDigest = computeWorldDigest({
      entities: nextEntities,
      relations: nextRelations,
    })

    const events: NewChronicleEvent[] = []
    for (const entity of entities) {
      events.push(worldEntityRecordedEvent(nextEntities.get(entity.id)!))
    }
    for (const id of relationIds) {
      events.push(worldRelationProjectedEvent(nextRelations.get(id)!))
    }
    events.push(
      worldVersionBumpedEvent({
        version: nextVersion,
        digest: nextDigest,
        at: now,
      }),
    )

    await this.#append(events)

    this.#entities.clear()
    for (const [id, entity] of nextEntities) this.#entities.set(id, entity)
    this.#relations.clear()
    for (const [id, relation] of nextRelations) {
      this.#relations.set(id, relation)
    }
    this.#version = nextVersion
    this.#digest = nextDigest
    return this.snapshot()
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  snapshot(): WorldSnapshot {
    return {
      version: this.#version,
      digest: this.#digest,
      entities: [...this.#entities.values()].sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
      relations: [...this.#relations.values()].sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    }
  }

  entity(id: string): WorldEntity | undefined {
    return this.#entities.get(id)
  }

  entities(
    query: { kind?: WorldEntityKind | undefined } = {},
  ): readonly WorldEntity[] {
    return this.snapshot().entities.filter(
      (entity) => query.kind === undefined || entity.kind === query.kind,
    )
  }

  relationsOf(
    entityId: string,
    query: { type?: WorldRelationType | undefined } = {},
  ): readonly WorldRelation[] {
    return this.snapshot().relations.filter(
      (relation) =>
        (relation.fromEntityId === entityId ||
          relation.toEntityId === entityId) &&
        (query.type === undefined || relation.type === query.type),
    )
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  #fold(eventType: string, payload: unknown): void {
    switch (eventType) {
      case 'world.entity.recorded': {
        const { entity } = payload as { entity: WorldEntity }
        const existing = this.#entities.get(entity.id)
        this.#entities.set(
          entity.id,
          mergeEntity(
            existing,
            {
              id: entity.id,
              kind: entity.kind,
              ...(entity.subtype === undefined
                ? {}
                : { subtype: entity.subtype }),
              attributes: entity.attributes,
              seenAt: entity.lastSeenAt,
            },
            entity.lastSeenAt,
          ),
        )
        return
      }
      case 'world.relation.projected': {
        const { relation } = payload as { relation: WorldRelation }
        this.#relations.set(relation.id, relation)
        return
      }
      case 'world.version.bumped': {
        const version = WorldVersionSchema.parse(payload)
        const actual = computeWorldDigest({
          entities: this.#entities,
          relations: this.#relations,
        })
        if (actual !== version.digest) {
          throw new WorldVersionDriftError(
            version.version,
            version.digest,
            actual,
          )
        }
        this.#version = version.version
        this.#digest = version.digest
        return
      }
      default:
        throw new UnknownWorldEventTypeError(eventType)
    }
  }

  async #append(events: readonly NewChronicleEvent[]): Promise<void> {
    if (events.length === 0) return
    for (let attempt = 0; ; attempt += 1) {
      const expected =
        (await this.#chronicle.getLatestSequence(WORLD_STREAM_ID)) + 1
      try {
        await this.#chronicle.append(WORLD_STREAM_ID, events, {
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
