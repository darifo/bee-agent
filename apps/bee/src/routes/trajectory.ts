import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import { buildTurnTrajectory, replayGeneration } from '@bee-agent/runtime'

/**
 * Trajectory routes (v1 refactor plan §5.5 WF4-E): the causal view over one
 * Turn — generations with structure versions and digest-verified model
 * inputs, tool actions with their authorization decisions, and checkpoints.
 * Read-only: trajectories are projections over durable facts.
 */

const TurnParamsSchema = z.object({
  threadId: z.uuid(),
  turnId: z.uuid(),
})
const RequestParamsSchema = z.object({ requestId: z.uuid() })

export const trajectoryRoutes: FastifyPluginAsync = async (app) => {
  app.get('/threads/:threadId/turns/:turnId/trajectory', async (request) => {
    const { threadId, turnId } = TurnParamsSchema.parse(request.params)
    return buildTurnTrajectory(app.bee.store, threadId, turnId)
  })

  app.get('/model-requests/:requestId/replay', async (request) => {
    const { requestId } = RequestParamsSchema.parse(request.params)
    return replayGeneration(app.bee.store, requestId)
  })
}
