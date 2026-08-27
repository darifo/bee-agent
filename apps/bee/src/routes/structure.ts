import type { FastifyPluginAsync } from 'fastify'
import { EffectiveStructureSchema } from '@bee-agent/kernel'
import { StructureGraphStore } from '@bee-agent/knowledge'

/** Local admin surface for inspecting and reconciling the desired structure. */
export const structureRoutes: FastifyPluginAsync = async (app) => {
  app.get('/structure', async () => {
    // The durable lineage view (WF4-D): replay the structure stream so the
    // response also answers "which versions ran, and what happened to them".
    const graph = new StructureGraphStore(app.bee.store)
    await graph.rebuild()
    const lineage = graph.snapshot()
    return {
      activeStructure: app.bee.structures.activeStructure ?? null,
      activeStructureVersion:
        app.bee.kernel.activeGeneration?.structureVersion ?? null,
      restartRequired: app.bee.kernel.restartRequired,
      restartRequiredPlugins: app.bee.kernel.restartRequiredPlugins,
      generations: app.bee.kernel.inspect(),
      doctor: app.bee.kernel.doctor(),
      configSource: app.bee.configController?.inspect() ?? null,
      lineage: {
        active: lineage.active,
        versions: lineage.entries.map((entry) => ({
          digest: entry.digest,
          supersededBy: entry.supersededBy,
          phases: entry.phases,
        })),
      },
    }
  })

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
