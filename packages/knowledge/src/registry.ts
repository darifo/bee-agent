import type { z } from 'zod'
import type { ChronicleEvent, NewChronicleEvent } from './envelope.js'
import { NewChronicleEventSchema } from './envelope.js'

/**
 * The Chronicle event type registry (v1 refactor plan §4.5): every event type
 * must be registered with a payload schema before it can be written, unknown
 * types fail loud on both write and replay, and only types explicitly marked
 * `ignorable` may be skipped when their payload no longer matches — the skip
 * decision is visible to the caller, never silent.
 */

export interface ChronicleTypeRegistrationOptions<T> {
  /** Payload schema; validated on append and on replay. */
  readonly payload: z.ZodType<T>
  /**
   * When true, replay-time payload mismatches can be skipped by the caller
   * instead of aborting projection rebuilds. Appends are still validated.
   */
  readonly ignorable?: boolean | undefined
}

export interface ChronicleTypeRegistration {
  readonly eventType: string
  readonly payload: z.ZodType<unknown>
  readonly ignorable: boolean
}

export class UnknownChronicleEventTypeError extends Error {
  constructor(readonly eventType: string) {
    super(`Unknown Chronicle event type '${eventType}'`)
    this.name = 'UnknownChronicleEventTypeError'
  }
}

export class ChronicleEventValidationError extends Error {
  constructor(
    readonly eventType: string,
    message: string,
    readonly cause?: z.ZodError,
  ) {
    super(`Event '${eventType}' failed validation: ${message}`)
    this.name = 'ChronicleEventValidationError'
  }
}

/** Replay-time validation outcome for one stored event. */
export type ReplayValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly ignorable: boolean; readonly error: Error }

export class ChronicleSchemaRegistry {
  readonly #types = new Map<string, ChronicleTypeRegistration>()

  register<T>(
    eventType: string,
    options: ChronicleTypeRegistrationOptions<T>,
  ): void {
    if (this.#types.has(eventType)) {
      throw new Error(
        `Chronicle event type '${eventType}' is already registered`,
      )
    }
    this.#types.set(eventType, {
      eventType,
      payload: options.payload as z.ZodType<unknown>,
      ignorable: options.ignorable ?? false,
    })
  }

  has(eventType: string): boolean {
    return this.#types.has(eventType)
  }

  listTypes(): readonly string[] {
    return [...this.#types.keys()]
  }

  /** Throws {@link UnknownChronicleEventTypeError} for unregistered types. */
  require(eventType: string): ChronicleTypeRegistration {
    const registration = this.#types.get(eventType)
    if (registration === undefined) {
      throw new UnknownChronicleEventTypeError(eventType)
    }
    return registration
  }

  /**
   * Validates an event before append: envelope shape first, then the payload
   * against the registered schema. Unknown event types are rejected. Throws
   * {@link ChronicleEventValidationError} or {@link UnknownChronicleEventTypeError}.
   */
  validateNew(event: NewChronicleEvent): void {
    const envelope = NewChronicleEventSchema.safeParse(event)
    if (!envelope.success) {
      throw new ChronicleEventValidationError(
        event.eventType,
        'envelope schema',
        envelope.error,
      )
    }
    const registration = this.require(event.eventType)
    const payload = registration.payload.safeParse(event.payload)
    if (!payload.success) {
      throw new ChronicleEventValidationError(
        event.eventType,
        'payload schema',
        payload.error,
      )
    }
  }

  /**
   * Validates a stored event for replay/projection: unknown types always
   * fail; payload mismatches fail unless the type was registered as
   * ignorable, in which case the caller may skip the event explicitly.
   */
  validateReplay(event: ChronicleEvent): ReplayValidation {
    const registration = this.#types.get(event.eventType)
    if (registration === undefined) {
      return {
        ok: false,
        ignorable: false,
        error: new UnknownChronicleEventTypeError(event.eventType),
      }
    }
    const payload = registration.payload.safeParse(event.payload)
    if (!payload.success) {
      return {
        ok: false,
        ignorable: registration.ignorable,
        error: new ChronicleEventValidationError(
          event.eventType,
          'payload schema',
          payload.error,
        ),
      }
    }
    return { ok: true }
  }
}
