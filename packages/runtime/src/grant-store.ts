import type { ChronicleStore } from '@bee-agent/knowledge'
import {
  GRANTS_STREAM_ID,
  grantRecordedEvent,
  grantRevokedEvent,
} from '@bee-agent/execution'

export interface GrantedCapability {
  readonly capability: string
  readonly reason: string | undefined
  readonly by: string
  readonly at: string
}

/**
 * Durable user grants (ADR 0023 user-grant layer): remembers approvals the
 * user chose to keep, on the serialized `grants` stream, and exposes the
 * live capability set the authorization policy consults. The set instance
 * is stable for the host's lifetime — structure rebuilds keep consulting
 * the same set — and is repopulated by {@link rebuild} on startup.
 */
export class UserGrantStore {
  readonly #store: ChronicleStore
  readonly #granted = new Set<string>()
  readonly #details = new Map<string, GrantedCapability>()

  constructor(store: ChronicleStore) {
    this.#store = store
  }

  /** The live grant set the policy decorates; stable reference. */
  get granted(): ReadonlySet<string> {
    return this.#granted
  }

  list(): readonly GrantedCapability[] {
    return [...this.#details.values()]
  }

  has(capability: string): boolean {
    return this.#granted.has(capability)
  }

  /** Replays the grants stream; the latest fact per capability wins. */
  async rebuild(): Promise<void> {
    this.#granted.clear()
    this.#details.clear()
    for await (const event of this.#store.readStream(GRANTS_STREAM_ID)) {
      const payload = event.payload as {
        capability?: unknown
        reason?: unknown
        by?: unknown
        at?: unknown
      }
      if (typeof payload.capability !== 'string') continue
      if (event.eventType === 'grant.recorded') {
        this.#granted.add(payload.capability)
        this.#details.set(payload.capability, {
          capability: payload.capability,
          reason:
            typeof payload.reason === 'string' ? payload.reason : undefined,
          by: typeof payload.by === 'string' ? payload.by : 'user',
          at: typeof payload.at === 'string' ? payload.at : event.eventTime,
        })
      } else if (event.eventType === 'grant.revoked') {
        this.#granted.delete(payload.capability)
        this.#details.delete(payload.capability)
      }
    }
  }

  async record(
    capability: string,
    reason?: string,
    by?: string,
  ): Promise<void> {
    await this.#append(grantRecordedEvent({ capability, reason, by }))
    this.#granted.add(capability)
    this.#details.set(capability, {
      capability,
      reason,
      by: by ?? 'user',
      at: new Date().toISOString(),
    })
  }

  async revoke(capability: string, reason?: string): Promise<void> {
    await this.#append(grantRevokedEvent({ capability, reason }))
    this.#granted.delete(capability)
    this.#details.delete(capability)
  }

  /** Appends at the stream tail; a lost race retries once from the new tail. */
  async #append(
    event:
      | ReturnType<typeof grantRecordedEvent>
      | ReturnType<typeof grantRevokedEvent>,
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const expected =
        (await this.#store.getLatestSequence(GRANTS_STREAM_ID)) + 1
      try {
        await this.#store.append(GRANTS_STREAM_ID, [event], {
          expectedSequence: expected,
        })
        return
      } catch {
        // concurrent writer moved the tail; retry from the new position
      }
    }
  }
}
