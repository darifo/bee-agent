import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  ChronicleEventSchema,
  NewChronicleEventSchema,
  newChronicleEvent,
} from '../src/envelope.ts'
import {
  ChronicleSchemaRegistry,
  UnknownChronicleEventTypeError,
} from '../src/registry.ts'

const actor = { type: 'agent', id: 'bee' }

describe('newChronicleEvent', () => {
  it('fills the documented defaults', () => {
    const event = newChronicleEvent({
      eventType: 'thread.turn.created',
      payload: { input: 'hi' },
      actor,
    })
    expect(event.eventId).toEqual(expect.any(String))
    expect(event.correlationId).toBe(event.eventId)
    expect(event.schemaVersion).toBe(1)
    expect(event.eventTime).toEqual(expect.any(String))
    expect(event.classification).toBe('internal')
    expect(event.retentionClass).toBe('default')
    expect(NewChronicleEventSchema.safeParse(event).success).toBe(true)
  })

  it('keeps explicit producer values, including dual-time and causality', () => {
    const cause = newChronicleEvent({
      eventType: 'a.cause',
      payload: {},
      actor,
    })
    const event = newChronicleEvent({
      eventType: 'a.effect',
      payload: {},
      actor,
      eventId: '00000000-0000-4000-8000-000000000001',
      correlationId: cause.correlationId,
      causationId: cause.eventId,
      parentIds: [cause.eventId],
      eventTime: '2026-01-01T00:00:00.000Z',
      validTime: { from: '2026-01-01T00:00:00.000Z' },
      threadId: 'thread-1',
      turnId: 'turn-1',
      classification: 'confidential',
      retentionClass: 'long',
      structureVersion: 'sha256:abc',
    })
    expect(event.correlationId).toBe(cause.correlationId)
    expect(event.causationId).toBe(cause.eventId)
    expect(event.validTime).toEqual({ from: '2026-01-01T00:00:00.000Z' })
    expect(event.classification).toBe('confidential')
    expect(event.structureVersion).toBe('sha256:abc')
  })

  it('produces envelopes that extend into the stored event shape', () => {
    const event = newChronicleEvent({
      eventType: 'a.stored',
      payload: 1,
      actor,
    })
    const stored = ChronicleEventSchema.safeParse({
      ...event,
      streamId: 's1',
      sequence: 1,
      ingestTime: new Date().toISOString(),
    })
    expect(stored.success).toBe(true)
  })

  it('rejects malformed envelopes strictly', () => {
    const event = newChronicleEvent({ eventType: 'a.x', payload: {}, actor })
    expect(
      NewChronicleEventSchema.safeParse({ ...event, bogusField: true }).success,
    ).toBe(false)
    expect(
      NewChronicleEventSchema.safeParse({ ...event, actor: { type: 'robot' } })
        .success,
    ).toBe(false)
    expect(
      NewChronicleEventSchema.safeParse({ ...event, correlationId: 'nope' })
        .success,
    ).toBe(false)
  })
})

describe('ChronicleSchemaRegistry', () => {
  it('validates payloads against the registered schema', () => {
    const registry = new ChronicleSchemaRegistry()
    registry.register('kv.seen', { payload: z.object({ key: z.string() }) })

    const good = newChronicleEvent({
      eventType: 'kv.seen',
      payload: { key: 'a' },
      actor,
    })
    expect(() => registry.validateNew(good)).not.toThrow()

    const bad = newChronicleEvent({
      eventType: 'kv.seen',
      payload: { key: 42 },
      actor,
    })
    expect(() => registry.validateNew(bad)).toThrow(/payload schema/)
  })

  it('fails loud on unknown types for both append and replay', () => {
    const registry = new ChronicleSchemaRegistry()
    const unknown = newChronicleEvent({
      eventType: 'nope.missing',
      payload: {},
      actor,
    })
    expect(() => registry.validateNew(unknown)).toThrow(
      UnknownChronicleEventTypeError,
    )

    const replay = registry.validateReplay({
      ...unknown,
      streamId: 's',
      sequence: 1,
      ingestTime: new Date().toISOString(),
    })
    expect(replay.ok).toBe(false)
    if (!replay.ok) expect(replay.ignorable).toBe(false)
  })

  it('allows ignorable types to be skipped only at replay', () => {
    const registry = new ChronicleSchemaRegistry()
    registry.register('maybe.drifting', {
      payload: z.object({ n: z.number() }),
      ignorable: true,
    })

    const event = {
      ...newChronicleEvent({
        eventType: 'maybe.drifting',
        payload: { n: 'not a number' },
        actor,
      }),
      streamId: 's',
      sequence: 1,
      ingestTime: new Date().toISOString(),
    }
    // Appends still validate strictly.
    expect(() =>
      registry.validateNew(
        newChronicleEvent({
          eventType: 'maybe.drifting',
          payload: { n: 'not a number' },
          actor,
        }),
      ),
    ).toThrow(/payload schema/)

    const replay = registry.validateReplay(event)
    expect(replay.ok).toBe(false)
    if (!replay.ok) expect(replay.ignorable).toBe(true)
  })

  it('rejects duplicate registrations', () => {
    const registry = new ChronicleSchemaRegistry()
    registry.register('dup.once', { payload: z.unknown() })
    expect(() =>
      registry.register('dup.once', { payload: z.unknown() }),
    ).toThrow(/already registered/)
  })
})
