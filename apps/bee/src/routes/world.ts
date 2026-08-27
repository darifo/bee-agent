import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { WorldModelStore } from '@bee-agent/knowledge'

/**
 * WorldModel observation routes (v1 refactor plan §5.5 WF4-D): a read-only
 * view over the versioned world projection. The world model only contains
 * projector-derived facts with provenance, so this surface answers "what
 * does Bee Agent know about its environment, and where did each fact come
 * from" without any mutation path.
 */

const QuerySchema = z.object({
  kind: z.enum(['actor', 'resource', 'capability', 'location']).optional(),
  type: z
    .enum([
      'owns',
      'depends_on',
      'contains',
      'connected_to',
      'authorized_for',
      'produced_by',
      'used',
    ])
    .optional(),
  entity: z.string().min(1).optional(),
})

export const worldRoutes: FastifyPluginAsync<{
  world: WorldModelStore
}> = async (app, options) => {
  const { world } = options

  app.get('/world', async (request) => {
    const query = QuerySchema.parse(request.query ?? {})
    const snapshot = world.snapshot()
    return {
      version: snapshot.version,
      digest: snapshot.digest,
      entities: snapshot.entities.filter(
        (entity) => query.kind === undefined || entity.kind === query.kind,
      ),
      relations: snapshot.relations.filter((relation) => {
        if (query.type !== undefined && relation.type !== query.type) {
          return false
        }
        if (query.entity === undefined) return true
        return (
          relation.fromEntityId === query.entity ||
          relation.toEntityId === query.entity
        )
      }),
    }
  })
}
