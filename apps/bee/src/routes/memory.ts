import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { MemoryProvider } from '@bee-agent/knowledge'

/**
 * Memory governance routes (v1 refactor plan §5.5 Phase 4 exit criteria):
 * the user can view what is remembered, forget a claim, run consolidation,
 * and export everything. Memory mutations are ordinary durable Chronicle
 * events (retraction), so these routes stay auditable like every other
 * side effect.
 */

const ClaimIdParamsSchema = z.object({ claimId: z.uuid() })

const ListQuerySchema = z.object({
  status: z.enum(['active', 'superseded', 'retracted']).optional(),
  kind: z.enum(['preference', 'fact', 'correction', 'procedure']).optional(),
})

const RetractBodySchema = z.object({ reason: z.string().min(1).optional() })

export const memoryRoutes: FastifyPluginAsync<{
  memory: MemoryProvider
}> = async (app, options) => {
  const { memory } = options

  // What Bee noticed, newest first — a read-only projection over the
  // durable observation events (claims are the distilled subset).
  app.get('/memory/observations', async (request) => {
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(200).optional() })
      .parse(request.query ?? {})
    const limit = query.limit ?? 100
    const observations: unknown[] = []
    for await (const event of app.bee.store.readStream('memory')) {
      if (event.eventType !== 'memory.observation.recorded') continue
      const payload = event.payload as { observation?: unknown }
      if (payload.observation === undefined) continue
      observations.unshift({
        ...(payload.observation as Record<string, unknown>),
        recordedAt: event.eventTime,
      })
      if (observations.length > limit) observations.pop()
    }
    return { observations }
  })

  app.get('/memory/claims', async (request) => {
    const query = ListQuerySchema.parse(request.query)
    const exported = await memory.export()
    return {
      claims: exported.claims.filter(
        (claim) =>
          (query.status === undefined || claim.status === query.status) &&
          (query.kind === undefined || claim.kind === query.kind),
      ),
    }
  })

  app.post('/memory/claims/:claimId/retract', async (request, reply) => {
    const { claimId } = ClaimIdParamsSchema.parse(request.params)
    const body = RetractBodySchema.parse(request.body ?? {})
    const claim = await memory.retract(
      claimId,
      body.reason === undefined ? undefined : body.reason,
    )
    return reply.code(200).send({ claim })
  })

  app.post('/memory/consolidate', async () => {
    return { report: await memory.consolidate() }
  })

  app.get('/memory/export', async () => {
    return memory.export()
  })
}
