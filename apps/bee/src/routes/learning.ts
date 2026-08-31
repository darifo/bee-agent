import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import {
  InvalidProposalTransitionError,
  ProposalNotFoundError,
  ProposalVersionConflictError,
} from '@bee-agent/learning'
import type { ChronicleProposalStore, LearningLoop } from '@bee-agent/learning'

/**
 * Learning governance routes (v1 refactor plan §5.6): run the slow loop,
 * inspect ImprovementProposals, and drive the
 * Proposal–Experiment–Trial–Rollback lifecycle. The loop itself only ever
 * creates proposals; every transition here is an explicit user decision,
 * recorded as a durable Chronicle fact.
 */

const ProposalIdParamsSchema = z.object({ proposalId: z.uuid() })

const ListQuerySchema = z.object({
  status: z
    .enum([
      'draft',
      'testing',
      'review',
      'trial',
      'promoted',
      'rejected',
      'rolled-back',
    ])
    .optional(),
  type: z
    .enum([
      'memory',
      'knowledge',
      'skill',
      'prompt',
      'context-policy',
      'planning-policy',
      'tool',
      'runtime-structure',
      'world-schema',
      'evaluation',
      'guardrail',
    ])
    .optional(),
  origin: z.enum(['loop', 'user']).optional(),
  autonomyLevel: z.coerce.number().int().min(0).max(3).optional(),
  limit: z.coerce.number().int().positive().optional(),
})

const TransitionBodySchema = z.object({
  to: z.enum([
    'draft',
    'testing',
    'review',
    'trial',
    'promoted',
    'rejected',
    'rolled-back',
  ]),
  expectedVersion: z.number().int().positive(),
  reason: z.string().min(1).optional(),
})

export interface BeeLearningRuntime {
  readonly proposals: ChronicleProposalStore
  readonly loop: LearningLoop
}

export const learningRoutes: FastifyPluginAsync<{
  learning: BeeLearningRuntime
}> = async (app, options) => {
  const { learning } = options

  app.post('/learning/run', async () => {
    return learning.loop.run()
  })

  app.get('/learning/budget', async () => {
    return learning.loop.budget()
  })

  app.get('/learning/proposals', async (request) => {
    const query = ListQuerySchema.parse(request.query ?? {})
    return {
      proposals: await learning.proposals.list({
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.type === undefined ? {} : { type: query.type }),
        ...(query.origin === undefined ? {} : { origin: query.origin }),
        ...(query.autonomyLevel === undefined
          ? {}
          : {
              autonomyLevel: query.autonomyLevel as 0 | 1 | 2 | 3,
            }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      }),
    }
  })

  app.get('/learning/proposals/:proposalId', async (request, reply) => {
    const { proposalId } = ProposalIdParamsSchema.parse(request.params)
    const proposal = await learning.proposals.get(proposalId)
    if (proposal === undefined) {
      return reply.code(404).send({
        code: 'not-found',
        message: `Improvement proposal '${proposalId}' was not found`,
      })
    }
    return { proposal }
  })

  app.post(
    '/learning/proposals/:proposalId/transition',
    async (request, reply) => {
      const { proposalId } = ProposalIdParamsSchema.parse(request.params)
      const body = TransitionBodySchema.parse(request.body)
      try {
        const proposal = await learning.proposals.transition(proposalId, {
          to: body.to,
          expectedVersion: body.expectedVersion,
          ...(body.reason === undefined ? {} : { reason: body.reason }),
        })
        return { proposal }
      } catch (error) {
        if (error instanceof ProposalNotFoundError) {
          return reply
            .code(404)
            .send({ code: 'not-found', message: error.message })
        }
        if (
          error instanceof ProposalVersionConflictError ||
          error instanceof InvalidProposalTransitionError
        ) {
          return reply
            .code(409)
            .send({ code: 'conflict', message: error.message })
        }
        throw error
      }
    },
  )
}
