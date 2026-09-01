import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import {
  buildGlobalTrajectory,
  buildTurnTrajectory,
  replayGeneration,
} from '@bee-agent/runtime'

/**
 * Trajectory routes (v1 refactor plan §5.5 WF4-E): the causal view over one
 * Turn — generations with structure versions and digest-verified model
 * inputs, tool actions with their authorization decisions, and checkpoints —
 * plus the global timeline over every Chronicle stream, split into the
 * foreground fast loop (user-facing turns) and the background slow loop
 * (memory, learning, governance). Read-only: trajectories are projections
 * over durable facts.
 */

const TurnParamsSchema = z.object({
  threadId: z.uuid(),
  turnId: z.uuid(),
})
const RequestParamsSchema = z.object({ requestId: z.uuid() })

const GlobalQuerySchema = z.object({
  loop: z.enum(['fast', 'slow']).optional(),
  category: z
    .enum(['input', 'llm', 'tool', 'memory', 'reasoning', 'proposal', 'system'])
    .optional(),
  streamId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})

export const trajectoryRoutes: FastifyPluginAsync = async (app) => {
  app.get('/trajectory', async (request) => {
    const query = GlobalQuerySchema.parse(request.query)
    return buildGlobalTrajectory(app.bee.store, query)
  })

  app.get('/threads/:threadId/turns/:turnId/trajectory', async (request) => {
    const { threadId, turnId } = TurnParamsSchema.parse(request.params)
    return buildTurnTrajectory(app.bee.store, threadId, turnId)
  })

  app.get('/model-requests/:requestId/replay', async (request) => {
    const { requestId } = RequestParamsSchema.parse(request.params)
    return replayGeneration(app.bee.store, requestId)
  })
}
