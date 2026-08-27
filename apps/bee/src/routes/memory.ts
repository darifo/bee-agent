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
