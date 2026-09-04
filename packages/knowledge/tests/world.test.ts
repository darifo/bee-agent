import { describe, expect, it } from 'vitest'
import { newChronicleEvent } from '../src/envelope.ts'
import { MemoryChronicleStore } from '../src/testing.ts'
import {
  ChronicleSchemaRegistry,
  ExecutionResourceProjector,
  ThreadToolProjector,
  WorldModelStore,
  WorldVersionDriftError,
  deterministicWorldId,
  registerMemoryChronicleEvents,
  registerWorldChronicleEvents,
  WORLD_STREAM_ID,
  memoryHealthChangedEvent,
} from '../src/index.ts'
import type { ChronicleEvent } from '../src/index.ts'

function createStore(): MemoryChronicleStore {
  const registry = new ChronicleSchemaRegistry()
  registerWorldChronicleEvents(registry)
  registerMemoryChronicleEvents(registry)
  return new MemoryChronicleStore(registry)
}

/** Fixture: a stored-shape `item.completed` tool_call event (not appended). */
function toolCallEvent(input: {
  readonly toolId: string
  readonly itemId: string
  readonly sequence: number
  readonly threadId?: string | undefined
  readonly turnId?: string | undefined
}): ChronicleEvent {
  const threadId = input.threadId ?? 't1'
  return {
    ...newChronicleEvent({
      eventType: 'item.completed',
      actor: { type: 'agent', id: 'bee' },
      threadId,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      payload: {
        item: {
          id: input.itemId,
          threadId,
          turnId: input.turnId ?? 'v1',
          status: 'completed',
          type: 'tool_call',
          createdAt: '2026-01-01T00:00:00Z',
          payload: { toolId: input.toolId, callId: 'c1', input: {} },
        },
      },
    }),
    streamId: `thread:${threadId}`,
    sequence: input.sequence,
    ingestTime: '2026-01-01T00:00:01Z',
  }
}

describe('world domain', () => {
  it('rebases over a historical digest drift instead of failing forever', async () => {
    const store = createStore()
    const world = new WorldModelStore({ store })
    await world.record({
      entities: [{ id: 'e1', kind: 'actor', seenAt: '2026-01-01T00:00:00Z' }],
    })
    // Corrupt the history: a bump whose digest matches nothing the events
    // can fold to (the write-side defect seen in production).
    await store.append(
      WORLD_STREAM_ID,
      [
        newChronicleEvent({
          eventType: 'world.version.bumped',
          actor: { type: 'system', id: 'test' },
          payload: {
            version: 99,
            digest: `sha256:${'0'.repeat(64)}`,
            at: '2026-01-02T00:00:00Z',
          },
        }),
      ],
      {
        expectedSequence: (await store.getLatestSequence(WORLD_STREAM_ID)) + 1,
      },
    )

    await expect(world.rebuild()).rejects.toBeInstanceOf(WorldVersionDriftError)
    await expect(world.rebuild({ onDrift: 'rebase' })).resolves.toBeUndefined()
    expect(world.driftNotice).toMatchObject({ detectedAtVersion: 99 })
    expect(world.driftNotice!.rebasedToVersion).toBeGreaterThan(99)
    const correctedVersion = world.snapshot().version
    // The corrective bump persisted and rebase is idempotent: a second
    // pass adds no new bump and lands on the same version. Strict rebuild
    // also passes — a bad bump immediately followed by a matching
    // corrective one is a repaired pair, not live drift.
    await expect(world.rebuild({ onDrift: 'rebase' })).resolves.toBeUndefined()
    expect(world.snapshot().version).toBe(correctedVersion)
    const strict = new WorldModelStore({ store })
    await expect(strict.rebuild()).resolves.toBeUndefined()
    expect(strict.snapshot().version).toBe(correctedVersion)
  })

  it('records projections with versioned digests', async () => {
    const store = createStore()
    const world = new WorldModelStore({
      store,
      now: () => '2026-01-01T00:00:00Z',
    })

    const first = await world.record({
      entities: [{ id: 'actor:bee', kind: 'actor', subtype: 'agent' }],
      relations: [
        {
          type: 'used',
          fromEntityId: 'actor:bee',
          toEntityId: 'capability:tool:lookup',
          provenance: { streamId: 'thread:t1', sequence: 4 },
        },
      ],
    })
    expect(first.version).toBe(1)
    expect(first.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(first.entities.map((entity) => entity.id)).toEqual(['actor:bee'])
    expect(first.relations).toHaveLength(1)

    const second = await world.record({
      entities: [
        {
          id: 'capability:tool:lookup',
          kind: 'capability',
          subtype: 'lookup',
        },
      ],
    })
    expect(second.version).toBe(2)
    expect(second.digest).not.toBe(first.digest)
    expect(second.entities).toHaveLength(2)
    await store.close()
  })

  it('rebuilds to the exact same digest after restart', async () => {
    const store = createStore()
    const world = new WorldModelStore({
      store,
      now: () => '2026-01-01T00:00:00Z',
    })
    await world.record({
      entities: [{ id: 'actor:bee', kind: 'actor' }],
      relations: [
        {
          type: 'used',
          fromEntityId: 'actor:bee',
          toEntityId: 'capability:tool:x',
          provenance: { streamId: 'thread:t1', sequence: 2 },
        },
      ],
    })
    const before = world.snapshot()

    const restarted = new WorldModelStore({ store })
    await restarted.rebuild()
    expect(restarted.snapshot()).toEqual(before)
    await store.close()
  })

  it('merges entity sightings and queries relations per entity', async () => {
    const store = createStore()
    const world = new WorldModelStore({
      store,
      now: () => '2026-01-01T00:00:00Z',
    })
    await world.record({
      entities: [{ id: 'resource:file:/tmp/a', kind: 'resource' }],
    })
    await world.record({
      entities: [
        {
          id: 'resource:file:/tmp/a',
          kind: 'resource',
          attributes: { bytes: 128 },
        },
        { id: 'actor:bee', kind: 'actor' },
      ],
      relations: [
        {
          type: 'produced_by',
          fromEntityId: 'resource:file:/tmp/a',
          toEntityId: 'actor:bee',
          provenance: { streamId: 'execution:x', sequence: 1 },
        },
      ],
    })

    const entity = world.entity('resource:file:/tmp/a')
    expect(entity?.attributes).toEqual({ bytes: 128 })
    expect(entity?.firstSeenAt).toBe(entity?.lastSeenAt)
    expect(world.relationsOf('actor:bee')).toHaveLength(1)
    expect(world.relationsOf('actor:bee', { type: 'used' })).toHaveLength(0)
    expect(world.entities({ kind: 'capability' })).toEqual([])
    await store.close()
  })

  it('rejects foreign event types in the world stream during rebuild', async () => {
    const store = createStore()
    await store.append(
      WORLD_STREAM_ID,
      [memoryHealthChangedEvent({ from: 'healthy', to: 'healthy' })],
      { expectedSequence: 1 },
    )
    const world = new WorldModelStore({ store })
    await expect(world.rebuild()).rejects.toThrow(/not a world event/)
    await store.close()
  })

  it('detects digest drift between recorded and replayed versions', () => {
    const error = new WorldVersionDriftError(3, 'sha256:a', 'sha256:b')
    expect(error.name).toBe('WorldVersionDriftError')
    expect(error.message).toContain('version 3')
  })
})

describe('ThreadToolProjector', () => {
  const projector = new ThreadToolProjector()

  it('derives a usage fact with exact provenance', () => {
    const event = toolCallEvent({
      toolId: 'lookup',
      itemId: 'item-9',
      sequence: 7,
      threadId: 't1',
      turnId: 'v1',
    })
    expect(projector.wants(event.streamId)).toBe(true)

    const projection = projector.project(event)
    expect(projection?.entities.map((entity) => entity.id).sort()).toEqual([
      'actor:bee',
      'capability:tool:lookup',
    ])
    const relation = projection!.relations[0]!
    expect(relation.type).toBe('used')
    expect(relation.fromEntityId).toBe('actor:bee')
    expect(relation.toEntityId).toBe('capability:tool:lookup')
    expect(relation.provenance).toEqual({
      streamId: 'thread:t1',
      sequence: 7,
      threadId: 't1',
      turnId: 'v1',
      itemId: 'item-9',
    })
    // The same source position always derives the same relation id.
    expect(relation.id).toBe(projector.project(event)!.relations[0]!.id)
  })

  it('ignores non-thread streams, non-tool events, and malformed payloads', () => {
    expect(projector.wants('execution:abc')).toBe(false)
    expect(projector.wants('memory')).toBe(false)

    const started = {
      ...toolCallEvent({ toolId: 'x', itemId: 'i', sequence: 1 }),
      eventType: 'item.started',
    }
    expect(projector.project(started as ChronicleEvent)).toBeUndefined()

    const malformed = {
      ...toolCallEvent({ toolId: 'x', itemId: 'i', sequence: 2 }),
      payload: { item: { type: 'tool_call', payload: {} } },
    }
    expect(projector.project(malformed as ChronicleEvent)).toBeUndefined()
  })
})

describe('deterministicWorldId', () => {
  it('produces stable v4-shaped uuids', () => {
    const a = deterministicWorldId('seed')
    expect(a).toBe(deterministicWorldId('seed'))
    expect(a).not.toBe(deterministicWorldId('other'))
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })
})

describe('ExecutionResourceProjector', () => {
  const projector = new ExecutionResourceProjector()

  /** Fixture: a stored-shape `execution.requested` event (not appended). */
  function executionRequestedEvent(input: {
    readonly streamId: string
    readonly sequence: number
    readonly idempotencyKey: string
    readonly readPaths?: readonly string[]
    readonly writePaths?: readonly string[]
    readonly commands?: readonly (readonly string[])[]
    readonly scope?: {
      readonly threadId?: string | undefined
      readonly turnId?: string | undefined
      readonly itemId?: string | undefined
    }
  }): ChronicleEvent {
    return {
      ...newChronicleEvent({
        eventType: 'execution.requested',
        actor: { type: 'agent', id: 'bee' },
        ...(input.scope?.threadId === undefined
          ? {}
          : { threadId: input.scope.threadId }),
        ...(input.scope?.turnId === undefined
          ? {}
          : { turnId: input.scope.turnId }),
        payload: {
          request: {
            id: crypto.randomUUID(),
            idempotencyKey: input.idempotencyKey,
            requirements: {
              readPaths: input.readPaths ?? [],
              writePaths: input.writePaths ?? [],
              commands: input.commands ?? [],
            },
            scope: input.scope ?? {},
          },
          requestDigest: 'sha256:' + '0'.repeat(64),
        },
      }),
      streamId: input.streamId,
      sequence: input.sequence,
      ingestTime: '2026-01-01T00:00:01Z',
    }
  }

  it('derives resource dependencies and executable capabilities', () => {
    const event = executionRequestedEvent({
      streamId: 'execution:abc123',
      sequence: 2,
      idempotencyKey: 'tool:t1:c1',
      readPaths: ['/tmp/notes.md'],
      writePaths: ['/tmp/out.txt', '/tmp/notes.md'],
      commands: [['/usr/bin/git', 'status']],
      scope: { threadId: 't1', turnId: 'v1', itemId: 'i1' },
    })
    expect(projector.wants(event.streamId)).toBe(true)

    const projection = projector.project(event)!
    const ids = projection.entities.map((entity) => entity.id).sort()
    expect(ids).toEqual([
      'actor:bee',
      'capability:command:/usr/bin/git',
      'resource:file:/tmp/notes.md',
      'resource:file:/tmp/out.txt',
    ])
    // The shared read/write path collapses into one dependency relation.
    const relations = projection.relations
    expect(relations).toHaveLength(3)
    const depends = relations.find(
      (relation) => relation.toEntityId === 'resource:file:/tmp/notes.md',
    )!
    expect(depends.type).toBe('depends_on')
    expect(depends.provenance).toEqual({
      streamId: 'execution:abc123',
      sequence: 2,
      threadId: 't1',
      turnId: 'v1',
      itemId: 'i1',
    })
    const used = relations.find(
      (relation) => relation.toEntityId === 'capability:command:/usr/bin/git',
    )!
    expect(used.type).toBe('used')
  })

  it('ignores pure-logical executions and foreign streams', () => {
    expect(projector.wants('thread:t1')).toBe(false)
    const logical = executionRequestedEvent({
      streamId: 'execution:def',
      sequence: 1,
      idempotencyKey: 'tool:t1:c2',
    })
    expect(projector.project(logical)).toBeUndefined()
    const other = {
      ...executionRequestedEvent({
        streamId: 'execution:def',
        sequence: 2,
        idempotencyKey: 'tool:t1:c3',
        writePaths: ['/tmp/x'],
      }),
      eventType: 'execution.completed',
    }
    expect(projector.project(other as ChronicleEvent)).toBeUndefined()
  })
})
