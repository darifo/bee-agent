import { z } from 'zod'
import {
  CreateMemoryDocumentRequestSchema,
  MemoryRecallRequestSchema,
} from '@bee-agent/contracts'
import type { FastifyPluginAsync } from 'fastify'

const ChunkParamsSchema = z.object({ chunkId: z.uuid() })
const ForgetQuerySchema = z.object({ workspaceId: z.string().min(1) })

/**
 * Workspace memory surface. Registered only when a Vector Store plugin is
 * mounted (ADR 0005 server-mode memory); without one these paths 404.
 */
export const memoryRoutes: FastifyPluginAsync = async (app) => {
  app.post('/memory/documents', async (request, reply) => {
    const body = CreateMemoryDocumentRequestSchema.parse(request.body)
    const remembered = await app.bee.memory.remember(body)
    await reply.code(201).send({
      document: remembered.document,
      chunks: remembered.chunks,
    })
  })

  app.post('/memory/recall', async (request) => {
    const body = MemoryRecallRequestSchema.parse(request.body)
    const results = await app.bee.memory.recall(body)
    return { results }
  })

  app.delete('/memory/chunks/:chunkId', async (request, reply) => {
    const params = ChunkParamsSchema.parse(request.params)
    const query = ForgetQuerySchema.parse(request.query)
    await app.bee.memory.forget(params.chunkId, query.workspaceId)
    await reply.code(204).send()
  })
}
