import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ChronicleEvent } from './envelope.ts'
import type { WorldProjectionInput } from './world-schema.ts'

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
