import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { ProposalStatus } from '@bee-agent/learning'

/**
 * The diagnostics surface (v1 refactor plan §5.7 WF6-A): one call answering
 * "is my Bee healthy, and where do I look if not" for `bee doctor`. Every
 * section is a read over state the Host already maintains — no new probes,
 * no side effects.
 */
export const diagnosticsRoutes: FastifyPluginAsync = async (app) => {
  // Durable user grants: list and revoke the approvals the user chose to
  // remember. Revoking restores the tool's ask behavior immediately.
  app.get('/grants', async () => {
    return { grants: app.bee.grantStore.list() }
  })

  app.post('/grants/:capability/revoke', async (request) => {
    const { capability } = z
      .object({ capability: z.string().min(1) })
      .parse(request.params)
    await app.bee.grantStore.revoke(
      decodeURIComponent(capability),
      'revoked from the web console',
    )
    return { grants: app.bee.grantStore.list() }
  })
  app.get('/diagnostics', async () => {
    const bee = app.bee
    const kernel = bee.kernel

    let memoryHealth:
      | {
          status: 'healthy' | 'degraded' | 'unavailable'
          detail?: string | undefined
        }
      | undefined
    try {
      memoryHealth = await bee.memory?.health()
    } catch (error) {
      memoryHealth = {
        status: 'unavailable',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
    let memoryClaims:
      Awaited<ReturnType<NonNullable<typeof bee.memory>['export']>> | undefined
    try {
      memoryClaims = await bee.memory?.export()
    } catch {
      memoryClaims = undefined // provider outage: counts stay unknown, not fatal
    }
    const world = bee.world?.snapshot()
    const drift = bee.learning?.drift.budget()

    const proposals =
      bee.learning === undefined
        ? undefined
        : {
            enabled: true,
            byStatus: await countBy(
              [
                'draft',
                'testing',
                'review',
                'trial',
                'promoted',
                'rejected',
                'rolled-back',
              ] as const,
              (status: ProposalStatus) =>
                bee.learning!.proposals.list({ status }),
            ),
            loopBudget: bee.learning.loop.budget(),
            driftBudget: drift,
          }

    return {
      status:
        kernel.restartRequired ||
        (memoryHealth?.status ?? 'healthy') === 'unavailable'
          ? 'degraded'
          : 'ok',
      structure: {
        activeVersion: kernel.activeGeneration?.structureVersion ?? null,
        restartRequired: kernel.restartRequired,
        restartRequiredPlugins: kernel.restartRequiredPlugins,
        doctor: kernel.doctor(),
        configSource: bee.configController?.inspect() ?? null,
      },
      memory:
        bee.memory === undefined
          ? { enabled: false }
          : {
              enabled: true,
              health: memoryHealth,
              claims: {
                total: memoryClaims?.claims.length ?? 0,
                active:
                  memoryClaims?.claims.filter(
                    (claim) => claim.status === 'active',
                  ).length ?? 0,
                retracted:
                  memoryClaims?.claims.filter(
                    (claim) => claim.status === 'retracted',
                  ).length ?? 0,
              },
            },
      world: bee.world
        ? {
            enabled: true,
            version: world?.version ?? 0,
            entities: world?.entities.length ?? 0,
            relations: world?.relations.length ?? 0,
          }
        : { enabled: false },
      scheduler: bee.scheduler
        ? { enabled: true, triggers: bee.scheduler.list().length }
        : { enabled: false },
      learning: proposals ?? { enabled: false },
      threads: {
        streams: (await bee.store.listStreams()).filter((id) =>
          id.startsWith('thread:'),
        ).length,
      },
    }
  })
}

async function countBy(
  keys: readonly ProposalStatus[],
  list: (key: ProposalStatus) => Promise<readonly unknown[]>,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const key of keys) {
    counts[key] = (await list(key)).length
  }
  return counts
}
