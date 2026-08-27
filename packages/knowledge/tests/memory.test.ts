import { describe, expect, it } from 'vitest'
import { ChronicleSchemaRegistry } from '../src/registry.ts'
import { MemoryChronicleStore } from '../src/testing.ts'
import { newChronicleEvent } from '../src/envelope.ts'
import {
  MEMORY_EVENT_TYPES,
  MEMORY_STREAM_ID,
  MemoryClaimSchema,
  memoryClaimRecordedEvent,
  memoryClaimRetractedEvent,
  memoryClaimSupersededEvent,
  memoryConsolidationCompletedEvent,
  memoryStreamId,
  UnknownMemoryEventTypeError,
  registerMemoryChronicleEvents,
} from '../src/index.ts'
import type { MemoryClaim } from '../src/index.ts'

function claim(overrides: Partial<MemoryClaim> = {}): MemoryClaim {
  return MemoryClaimSchema.parse({
    id: crypto.randomUUID(),
    kind: 'preference',
    statement: 'Prefer concise answers',
    subject: { type: 'user' },
    provenance: {
      streamId: 'thread:t1',
      sequence: 3,
      threadId: 't1',
      turnId: 'v1',
      itemId: 'i1',
    },
    validTime: { from: '2026-01-01T00:00:00Z' },
    confidence: 0.6,
    status: 'active',
    supersedes: [],
    recordedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  })
}

describe('memory domain', () => {
  it('accepts a complete claim and rejects unknown fields', () => {
    const parsed = claim()
    expect(parsed.status).toBe('active')

    expect(() => MemoryClaimSchema.parse({ ...claim(), extra: true })).toThrow()
  })

  it('rejects confidence outside [0, 1] and empty statements', () => {
    expect(() => claim({ confidence: 1.5 })).toThrow()
    expect(() => claim({ statement: '' })).toThrow()
  })
})

describe('memory events', () => {
  it('registers every memory event type on a Chronicle registry', () => {
    const registry = new ChronicleSchemaRegistry()
    registerMemoryChronicleEvents(registry)
    for (const eventType of MEMORY_EVENT_TYPES) {
      expect(registry.has(eventType)).toBe(true)
    }
    expect(() => registerMemoryChronicleEvents(registry)).toThrow()
  })

  it('round-trips memory mutations through the memory stream', async () => {
    const registry = new ChronicleSchemaRegistry()
    registerMemoryChronicleEvents(registry)
    const store = new MemoryChronicleStore(registry)

    const first = claim()
    const second = claim()
    await store.append(
      memoryStreamId(),
      [
        memoryClaimRecordedEvent(first),
        memoryClaimRecordedEvent(second),
        memoryClaimSupersededEvent({
          claimId: first.id,
          supersededBy: second.id,
          reason: 'duplicate',
        }),
        memoryClaimRetractedEvent({ claimId: second.id, reason: 'forgotten' }),
        memoryConsolidationCompletedEvent({
          considered: 2,
          merged: [{ kept: second.id, superseded: [first.id] }],
          at: '2026-01-02T00:00:00Z',
        }),
      ],
      { expectedSequence: 1 },
    )

    const types: string[] = []
    for await (const event of store.readStream(MEMORY_STREAM_ID)) {
      types.push(event.eventType)
    }
    expect(types).toEqual([
      'memory.claim.recorded',
      'memory.claim.recorded',
      'memory.claim.superseded',
      'memory.claim.retracted',
      'memory.consolidation.completed',
    ])
    await store.close()
  })

  it('rejections keep unknown event types out of the memory stream', () => {
    const registry = new ChronicleSchemaRegistry()
    registerMemoryChronicleEvents(registry)
    expect(() =>
      registry.validateNew(
        newChronicleEvent({
          eventType: 'memory.claim.exploded',
          payload: {},
          actor: { type: 'agent', id: 'bee' },
        }),
      ),
    ).toThrow(/Unknown Chronicle event type/)
    expect(new UnknownMemoryEventTypeError('x').name).toBe(
      'UnknownMemoryEventTypeError',
    )
  })
})
