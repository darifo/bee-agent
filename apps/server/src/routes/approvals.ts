import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'

const ApprovalQuerySchema = z.object({
  taskId: z.uuid().optional(),
})

const DecisionBodySchema = z.object({
  approved: z.boolean(),
  reason: z.string().min(1).optional(),
})

export const approvalRoutes: FastifyPluginAsync = async (app) => {
  app.get('/approvals', async (request) => {
    const query = ApprovalQuerySchema.parse(request.query ?? {})
    return {
      approvals: app.bee.runtime.listPendingApprovals(query?.taskId),
    }
  })

  app.post('/approvals/:requestId/decision', async (request) => {
    const requestId = z
      .uuid()
      .parse((request.params as { requestId?: unknown }).requestId)
    const body = DecisionBodySchema.parse(request.body)
    return await app.bee.runtime.resolveApproval(
      requestId,
      body.approved,
      body.reason === undefined ? {} : { reason: body.reason },
    )
  })
}
