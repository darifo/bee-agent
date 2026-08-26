import { describe, expect, it } from 'vitest'
import { BundleSchema, resolveEffectiveStructure } from '@bee-agent/kernel'
import type { EffectiveStructure } from '@bee-agent/kernel'
import {
  ChronicleSchemaRegistry,
  STRUCTURE_ACTIVATED_EVENT_TYPE,
  STRUCTURE_ACTIVATION_FAILED_EVENT_TYPE,
  STRUCTURE_RESTART_REQUIRED_EVENT_TYPE,
  STRUCTURE_STREAM_ID,
  registerStructureChronicleEvents,
} from '@bee-agent/knowledge'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'
import { registerThreadChronicleEvents } from '@bee-agent/thread'
import { registerRuntimeChronicleEvents } from '@bee-agent/runtime'
import { registerKanbanChronicleEvents } from '@bee-agent/kanban'
import { createMemoryKanbanStore } from '@bee-agent/kanban/testing'
import { createFakeLlmRuntime } from '@bee-agent/runtime/testing'
import type { LlmRuntime, ToolExecutor } from '@bee-agent/runtime'
import {
  buildBeeServer,
  createBeeKernelRuntime,
  modelBindingKey,
} from '../src/index.ts'

async function hostStructure(
  model: string,
  sandbox = '1.0.0',
): Promise<EffectiveStructure> {
  return resolveEffectiveStructure(
    BundleSchema.parse({
      id: 'bee-host-test',
      version: `${model}-${sandbox}`,
      model: { id: 'host-model', version: model },
      prompt: { id: 'bee-system', version: '1.0.0' },
      contextPolicy: { id: 'bee-default', version: '1.0.0' },
      memoryView: { id: 'bee-personal', version: '1.0.0' },
      sandbox: { id: 'bee-local', version: sandbox },
      evalPolicy: { id: 'bee-default', version: '1.0.0' },
    }),
  )
}

function chronicle(): MemoryChronicleStore {
  const registry = new ChronicleSchemaRegistry()
  registerStructureChronicleEvents(registry)
  registerThreadChronicleEvents(registry)
  registerRuntimeChronicleEvents(registry)
  return new MemoryChronicleStore(registry)
}

function kanban() {
  const registry = new ChronicleSchemaRegistry()
  registerKanbanChronicleEvents(registry)
  return createMemoryKanbanStore(registry)
}

const tools: ToolExecutor = {
  describe(call) {
    return {
      capability: `tool:${call.toolId}`,
      requirements: {
        readPaths: [],
        writePaths: [],
        networkTargets: [],
        commands: [],
        secretEnv: {},
      },
      expectedEffects: ['No side effects'],
      verification: ['Completed'],
    }
  },
  async execute() {
    return { output: {}, content: 'ok', verification: ['Completed'] }
  },
}

async function structureEventTypes(
  store: MemoryChronicleStore,
): Promise<readonly string[]> {
  const result: string[] = []
  for await (const event of store.readStream(STRUCTURE_STREAM_ID)) {
    result.push(event.eventType)
  }
  return result
}

describe('Bee Host structure runtime', () => {
  it('switches model generations, records failures/C-tier changes, and restores active structure', async () => {
    const store = chronicle()
    const board = kanban()
    const modelA = createFakeLlmRuntime({ script: [], model: 'model-a' })
    const modelB = createFakeLlmRuntime({ script: [], model: 'model-b' })
    const providers = new Map<string, LlmRuntime>([
      [modelBindingKey('host-model', 'model-b'), modelB],
    ])
    const runtime = await createBeeKernelRuntime({
      store,
      kanban: board,
      llm: modelA,
      modelProviders: providers,
      toolExecutor: tools,
      toolAuthorization: [],
      toolSpecs: [],
      effectiveStructure: await hostStructure('model-a'),
    })
    expect(runtime.kernel.service('llm')).toBe(modelA)

    const switched = await runtime.reconcile(await hostStructure('model-b'))
    expect(switched.kind).toBe('activated')
    expect(runtime.kernel.service('llm')).toBe(modelB)

    await expect(
      runtime.reconcile(await hostStructure('missing-model')),
    ).rejects.toThrow(/No model provider is bound/)
    expect(runtime.kernel.service('llm')).toBe(modelB)

    const restart = await runtime.reconcile(
      await hostStructure('model-b', '2.0.0'),
    )
    expect(restart).toEqual({
      kind: 'restart-required',
      pluginIds: ['bee.sandbox-policy'],
    })
    expect(runtime.kernel.service('llm')).toBe(modelB)
    await runtime.stop()

    const types = await structureEventTypes(store)
    expect(types).toEqual(
      expect.arrayContaining([
        STRUCTURE_ACTIVATED_EVENT_TYPE,
        STRUCTURE_ACTIVATION_FAILED_EVENT_TYPE,
        STRUCTURE_RESTART_REQUIRED_EVENT_TYPE,
      ]),
    )

    const restored = await createBeeKernelRuntime({
      store,
      kanban: board,
      llm: modelA,
      modelProviders: providers,
      toolExecutor: tools,
      toolAuthorization: [],
      toolSpecs: [],
    })
    expect(restored.kernel.activeGeneration?.structureVersion).toBe(
      (await hostStructure('model-b')).digest,
    )
    expect(restored.kernel.service('llm')).toBe(modelB)
    await restored.stop()
  })

  it('exposes structure inspection and reconciliation through the Host', async () => {
    const modelA = createFakeLlmRuntime({ script: [], model: 'model-a' })
    const modelB = createFakeLlmRuntime({ script: [], model: 'model-b' })
    const server = await buildBeeServer({
      store: chronicle(),
      kanban: kanban(),
      llm: modelA,
      modelProviders: new Map([
        [modelBindingKey('host-model', 'model-b'), modelB],
      ]),
      toolExecutor: tools,
      effectiveStructure: await hostStructure('model-a'),
      logger: false,
    })
    const selected = await hostStructure('model-b')
    const response = await server.app.inject({
      method: 'POST',
      url: '/structure/reconcile',
      payload: selected,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      kind: 'activated',
      structureVersion: selected.digest,
    })
    const inspection = await server.app.inject({
      method: 'GET',
      url: '/structure',
    })
    expect(inspection.json()).toMatchObject({
      activeStructure: { digest: selected.digest },
      activeStructureVersion: selected.digest,
      restartRequired: false,
    })
    await server.app.close()
  })
})
