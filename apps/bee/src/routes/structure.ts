import type { FastifyPluginAsync } from 'fastify'
import { EffectiveStructureSchema } from '@bee-agent/kernel'

/** Local admin surface for inspecting and reconciling the desired structure. */
export const structureRoutes: FastifyPluginAsync = async (app) => {
  app.get('/structure', async () => ({
    activeStructure: app.bee.structures.activeStructure ?? null,
    activeStructureVersion:
      app.bee.kernel.activeGeneration?.structureVersion ?? null,
    restartRequired: app.bee.kernel.restartRequired,
    restartRequiredPlugins: app.bee.kernel.restartRequiredPlugins,
    generations: app.bee.kernel.inspect(),
    doctor: app.bee.kernel.doctor(),
    configSource: app.bee.configController?.inspect() ?? null,
  }))

  app.post('/structure/reconcile', async (request) => {
    const structure = EffectiveStructureSchema.parse(request.body)
    const result = await app.bee.structures.reconcile(structure)
    if (result.kind === 'restart-required') {
      return {
        kind: result.kind,
        structureVersion: structure.digest,
        pluginIds: result.pluginIds,
      }
    }
    return {
      kind: result.kind,
      structureVersion: result.generation.structureVersion,
      generationId: result.generation.id,
    }
  })
}
