import type { EffectiveStructure } from '@bee-agent/kernel'
import type { ChronicleStore } from './chronicle-store.ts'
import {
  STRUCTURE_ACTIVATED_EVENT_TYPE,
  STRUCTURE_ACTIVATION_FAILED_EVENT_TYPE,
  STRUCTURE_DISPOSED_EVENT_TYPE,
  STRUCTURE_DRAINING_EVENT_TYPE,
  STRUCTURE_PREPARED_EVENT_TYPE,
  STRUCTURE_RESTART_REQUIRED_EVENT_TYPE,
  STRUCTURE_RESOLVED_EVENT_TYPE,
  STRUCTURE_STREAM_ID,
  STRUCTURE_UPDATED_EVENT_TYPE,
  StructureActivationFailedPayloadSchema,
  StructureLifecyclePayloadSchema,
  StructureResolvedPayloadSchema,
  StructureRestartRequiredPayloadSchema,
} from './structure-events.ts'

/**
 * The StructureGraph projection (architecture §7.3, v1 refactor plan §5.5
 * WF4-D): the Host's own structure, versioned and observed. It replays the
 * `structure` Chronicle stream into a lineage view — every resolved
 * EffectiveStructure with its full lifecycle (prepared, activated, updated,
 * drained, disposed, failed candidates, restart requirements), which version
 * replaced which, and which one ran last. Slow-loop proposals reference
 * these versions when they suggest structure changes.
 */

export type StructurePhase =
  | 'resolved'
  | 'prepared'
  | 'activated'
  | 'updated'
  | 'draining'
  | 'disposed'
  | 'activation_failed'
  | 'restart_required'

export interface StructureGraphPhase {
  readonly phase: StructurePhase
  readonly generationId: string | undefined
  readonly at: string
  readonly error:
    { readonly name: string; readonly message: string } | undefined
  readonly pluginIds: readonly string[] | undefined
}

export interface StructureGraphEntry {
  readonly digest: string
  readonly structure: EffectiveStructure
  /** Lifecycle phases in stream order, starting with `resolved`. */
  readonly phases: readonly StructureGraphPhase[]
  /** The digest of the version that replaced this one, if any. */
  readonly supersededBy: string | undefined
}

export interface StructureGraphSnapshot {
  /** The digest that ran last (activated or in-place updated). */
  readonly active: string | undefined
  /** All resolved versions in first-resolution order. */
  readonly entries: readonly StructureGraphEntry[]
}

export class UnknownStructureEventTypeError extends Error {
  constructor(readonly eventType: string) {
    super(`Event type '${eventType}' is not a structure lineage event`)
    this.name = 'UnknownStructureEventTypeError'
  }
}

/**
 * Replay projection over the `structure` stream. Rebuild it whenever the
 * process needs a lineage view; the stream remains the source of truth
 * (`readActiveStructure` covers the common restore path).
 */
export class StructureGraphStore {
  readonly #store: ChronicleStore
  readonly #entries: StructureGraphEntry[] = []
  readonly #byDigest = new Map<string, StructureGraphEntry>()
  #active: string | undefined

  constructor(store: ChronicleStore) {
    this.#store = store
  }

  async rebuild(): Promise<void> {
    this.#entries.length = 0
    this.#byDigest.clear()
    this.#active = undefined
    for await (const event of this.#store.readStream(STRUCTURE_STREAM_ID)) {
      switch (event.eventType) {
        case STRUCTURE_RESOLVED_EVENT_TYPE: {
          const payload = StructureResolvedPayloadSchema.parse(event.payload)
          if (this.#byDigest.has(payload.digest)) continue
          const previous = this.#entries.at(-1)
          if (previous !== undefined) {
            const superseded: StructureGraphEntry = {
              ...previous,
              supersededBy: payload.digest,
            }
            this.#entries[this.#entries.length - 1] = superseded
            this.#byDigest.set(previous.digest, superseded)
          }
          const entry: StructureGraphEntry = {
            digest: payload.digest,
            structure: payload.structure,
            phases: [
              {
                phase: 'resolved',
                generationId: undefined,
                at: event.ingestTime,
                error: undefined,
                pluginIds: undefined,
              },
            ],
            supersededBy: undefined,
          }
          this.#entries.push(entry)
          this.#byDigest.set(entry.digest, entry)
          continue
        }
        case STRUCTURE_PREPARED_EVENT_TYPE:
        case STRUCTURE_ACTIVATED_EVENT_TYPE:
        case STRUCTURE_UPDATED_EVENT_TYPE:
        case STRUCTURE_DRAINING_EVENT_TYPE:
        case STRUCTURE_DISPOSED_EVENT_TYPE: {
          const payload = StructureLifecyclePayloadSchema.parse(event.payload)
          const phase = payload.phase as StructurePhase
          if (phase === 'activated' || phase === 'updated') {
            this.#active = payload.digest
          }
          this.#recordPhase(event, payload.digest, {
            phase,
            generationId: payload.generationId,
          })
          continue
        }
        case STRUCTURE_ACTIVATION_FAILED_EVENT_TYPE: {
          const payload = StructureActivationFailedPayloadSchema.parse(
            event.payload,
          )
          this.#recordPhase(event, payload.digest, {
            phase: 'activation_failed',
            generationId: payload.generationId,
            error: payload.error,
          })
          continue
        }
        case STRUCTURE_RESTART_REQUIRED_EVENT_TYPE: {
          const payload = StructureRestartRequiredPayloadSchema.parse(
            event.payload,
          )
          this.#recordPhase(event, payload.digest, {
            phase: 'restart_required',
            generationId: payload.generationId,
            pluginIds: payload.pluginIds,
          })
          continue
        }
        default:
          throw new UnknownStructureEventTypeError(event.eventType)
      }
    }
  }

  snapshot(): StructureGraphSnapshot {
    return { active: this.#active, entries: [...this.#entries] }
  }

  /** The lineage entry for one structure digest. */
  version(digest: string): StructureGraphEntry | undefined {
    return this.#byDigest.get(digest)
  }

  #recordPhase(
    event: { ingestTime: string },
    digest: string,
    phase: Omit<StructureGraphPhase, 'at' | 'error' | 'pluginIds'> & {
      error?: StructureGraphPhase['error']
      pluginIds?: StructureGraphPhase['pluginIds']
    },
  ): void {
    const entry = this.#byDigest.get(digest)
    if (entry === undefined) {
      throw new Error(
        `Structure lifecycle event for unknown digest '${digest}'`,
      )
    }
    const appended: StructureGraphEntry = {
      ...entry,
      phases: [
        ...entry.phases,
        {
          phase: phase.phase,
          generationId: phase.generationId,
          at: event.ingestTime,
          error: phase.error ?? undefined,
          pluginIds: phase.pluginIds ?? undefined,
        },
      ],
    }
    this.#byDigest.set(digest, appended)
    const index = this.#entries.findIndex(
      (candidate) => candidate.digest === digest,
    )
    this.#entries[index] = appended
  }
}
