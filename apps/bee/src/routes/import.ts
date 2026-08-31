import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import { importV0Database } from '../import-v0.ts'

/**
 * Migration routes (v1 refactor plan §5.7 WF6-C): import a v0 SQLite event
 * store by absolute path. The Host opens the file read-only; each v0 task
 * becomes one v1 thread. Re-running skips already-imported threads, so the
 * operation is safe to retry.
 */
const ImportBodySchema = z.object({
  path: z
    .string()
    .min(1)
    .refine((value) => value.startsWith('/'), {
      message: 'path must be absolute',
    }),
})

export const importRoutes: FastifyPluginAsync = async (app) => {
  app.post('/import/v0', async (request, reply) => {
    const body = ImportBodySchema.parse(request.body)
    try {
      const summary = await importV0Database({
        path: body.path,
        store: app.bee.store,
      })
      return summary
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (
        /[Cc]annot open database|SQLITE_CANTOPEN|does not exist/.test(message)
      ) {
        return reply.code(404).send({
          code: 'not-found',
          message: `Cannot open v0 database at '${body.path}': ${message}`,
        })
      }
      throw error
    }
  })
}
