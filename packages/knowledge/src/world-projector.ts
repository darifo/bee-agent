import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ChronicleEvent } from './envelope.ts'
import type {
  NewWorldEntityInput,
  NewWorldRelationInput,
  WorldProjectionInput,
} from './world-schema.ts'

/**
 * Sourced world projectors (architecture §7.2, v1 refactor plan §5.5 WF4-D):
 * the only way facts enter the WorldModel. A projector derives entities and
 * provenance-carrying relations from Chronicle events that already happened —
 * it never invents state, and the world store refuses unevidenced input by
 * construction (every relation must cite its source position).
 */

export interface WorldProjector {
  /** Stable id for diagnostics. */
  readonly id: string
  /** Whether this projector consumes events from the given stream. */
  wants(streamId: string): boolean
  /** Derives world facts from one source event; undefined when nothing fits. */
  project(event: ChronicleEvent): WorldProjectionInput | undefined
}

/** Formats 32 hex chars as a valid v4-shaped uuid (deterministic per seed). */
export function deterministicWorldId(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32)
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16) +
      hex.slice(17, 20),
    hex.slice(20, 32),
  ].join('-')
}

/** The agent actor every Bee Host projection refers to. */
export const BEE_ACTOR_ENTITY_ID = 'actor:bee'

/**
 * Structural shape of a completed `tool_call` item event. Parsed locally so
 * knowledge never depends on the thread package's schemas.
 */
const ToolCallItemEventSchema = z
  .object({
    item: z
      .object({
        id: z.string().min(1),
        type: z.literal('tool_call'),
        payload: z.object({ toolId: z.string().min(1) }).passthrough(),
      })
      .passthrough(),
  })
  .passthrough()

/**
 * Reference projector: every completed tool call in a thread becomes a usage
 * fact — the agent actor `used` the tool capability, citing the exact item
 * position. This is the seed of the "who used which capability, when" view;
 * richer projectors (execution resources, worktrees, MCP servers) follow the
 * same seam.
 */
export class ThreadToolProjector implements WorldProjector {
  readonly id = 'thread-tool-usage'

  wants(streamId: string): boolean {
    return streamId.startsWith('thread:')
  }

  project(event: ChronicleEvent): WorldProjectionInput | undefined {
    if (event.eventType !== 'item.completed') return undefined
    const parsed = ToolCallItemEventSchema.safeParse(event.payload)
    if (!parsed.success) return undefined
    const { item } = parsed.data
    const toolId = item.payload.toolId
    const capabilityId = `capability:tool:${toolId}`
    return {
      entities: [
        {
          id: BEE_ACTOR_ENTITY_ID,
          kind: 'actor',
          subtype: 'agent',
        },
        {
          id: capabilityId,
          kind: 'capability',
          subtype: toolId,
        },
      ],
      relations: [
        {
          id: deterministicWorldId(`used:${event.streamId}:${event.sequence}`),
          type: 'used',
          fromEntityId: BEE_ACTOR_ENTITY_ID,
          toEntityId: capabilityId,
          provenance: {
            streamId: event.streamId,
            sequence: event.sequence,
            ...(event.threadId === undefined
              ? {}
              : { threadId: event.threadId }),
            ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
            itemId: item.id,
          },
          validTime: { from: event.eventTime },
          recordedAt: event.ingestTime,
        },
      ],
    }
  }
}

/**
 * Structural shape of an `execution.requested` event. Parsed locally so
 * knowledge never depends on the execution package's schemas.
 */
const ExecutionRequestedEventSchema = z
  .object({
    request: z
      .object({
        idempotencyKey: z.string().min(1),
        requirements: z
          .object({
            readPaths: z.array(z.string().min(1)),
            writePaths: z.array(z.string().min(1)),
            commands: z.array(z.array(z.string().min(1)).min(1)),
          })
          .passthrough(),
        scope: z
          .object({
            threadId: z.string().min(1).optional(),
            turnId: z.string().min(1).optional(),
            itemId: z.string().min(1).optional(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough()

/**
 * Environment projector: every declared execution requirement becomes a
 * world fact — file resources the action depends on, and the native
 * executables behind its commands as capabilities the agent used. The
 * relations cite the exact `execution.requested` position, so the world
 * model answers "which files and binaries has my agent been touching".
 */
export class ExecutionResourceProjector implements WorldProjector {
  readonly id = 'execution-resources'

  wants(streamId: string): boolean {
    return streamId.startsWith('execution:')
  }

  project(event: ChronicleEvent): WorldProjectionInput | undefined {
    if (event.eventType !== 'execution.requested') return undefined
    const parsed = ExecutionRequestedEventSchema.safeParse(event.payload)
    if (!parsed.success) return undefined
    const { request } = parsed.data
    const { readPaths, writePaths, commands } = request.requirements
    if (
      readPaths.length === 0 &&
      writePaths.length === 0 &&
      commands.length === 0
    ) {
      return undefined
    }

    const entities: NewWorldEntityInput[] = [
      { id: BEE_ACTOR_ENTITY_ID, kind: 'actor', subtype: 'agent' },
    ]
    const relations: NewWorldRelationInput[] = []
    const seen = new Set<string>()

    const provenance = {
      streamId: event.streamId,
      sequence: event.sequence,
      ...(request.scope.threadId === undefined
        ? {}
        : { threadId: request.scope.threadId }),
      ...(request.scope.turnId === undefined
        ? {}
        : { turnId: request.scope.turnId }),
      ...(request.scope.itemId === undefined
        ? {}
        : { itemId: request.scope.itemId }),
    }

    for (const path of [...readPaths, ...writePaths]) {
      const entityId = `resource:file:${path}`
      if (seen.has(entityId)) continue
      seen.add(entityId)
      entities.push({
        id: entityId,
        kind: 'resource',
        subtype: 'file',
        attributes: { path },
      })
      relations.push({
        id: deterministicWorldId(
          `depends:${request.idempotencyKey}:${entityId}`,
        ),
        type: 'depends_on',
        fromEntityId: BEE_ACTOR_ENTITY_ID,
        toEntityId: entityId,
        provenance,
        validTime: { from: event.eventTime },
        recordedAt: event.ingestTime,
      })
    }
    for (const argv of commands) {
      const executable = argv[0]!
      const entityId = `capability:command:${executable}`
      if (seen.has(entityId)) continue
      seen.add(entityId)
      entities.push({
        id: entityId,
        kind: 'capability',
        subtype: 'native-executable',
        attributes: { executable },
      })
      relations.push({
        id: deterministicWorldId(`used:${request.idempotencyKey}:${entityId}`),
        type: 'used',
        fromEntityId: BEE_ACTOR_ENTITY_ID,
        toEntityId: entityId,
        provenance,
        validTime: { from: event.eventTime },
        recordedAt: event.ingestTime,
      })
    }
    return { entities, relations }
  }
}
