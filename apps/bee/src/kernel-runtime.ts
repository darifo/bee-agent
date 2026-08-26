import type { ChronicleStore } from '@bee-agent/knowledge'
import type { KanbanStore } from '@bee-agent/kanban'
import {
  BundleSchema,
  resolveEffectiveStructure,
  type EffectiveStructure,
  type GenerationLease,
  type Kernel,
  type ReconcileResult,
  type ReplacementTier,
  type RuntimePlugin,
} from '@bee-agent/kernel'
import type {
  AgentLoopRecoverInput,
  AgentLoopResumeInput,
  AgentLoopRunInput,
  AgentLoopTurnResult,
  LlmRuntime,
  LlmToolSpec,
  ToolAuthorizationRule,
  ToolExecutor,
} from '@bee-agent/runtime'
import {
  AGENT_LOOP_SERVICE,
  PluginFactoryRegistry,
  StructureReconciler,
  createAgentLoopPlugin,
  createModelRequestPlugin,
  createToolExecutionPlugin,
} from '@bee-agent/runtime'

export interface AgentLoopService {
  runTurn(input: AgentLoopRunInput): Promise<AgentLoopTurnResult>
  recoverTurn(input: AgentLoopRecoverInput): Promise<AgentLoopTurnResult>
  resumeTurn(input: AgentLoopResumeInput): Promise<AgentLoopTurnResult>
}

export interface BeeKernelRuntimeOptions {
  readonly store: ChronicleStore
  readonly kanban: KanbanStore
  readonly llm: LlmRuntime
  readonly toolExecutor: ToolExecutor
  readonly toolAuthorization: readonly ToolAuthorizationRule[]
  readonly toolSpecs: readonly LlmToolSpec[]
  readonly effectiveStructure?: EffectiveStructure | undefined
  readonly modelId?: string | undefined
  /** Additional providers keyed by `<structure model id>@<model version>`. */
  readonly modelProviders?: ReadonlyMap<string, LlmRuntime> | undefined
  readonly restoreActiveStructure?: boolean | undefined
}

export interface BeeKernelRuntime {
  readonly kernel: Kernel
  readonly structures: StructureReconciler
  readonly loop: AgentLoopService
  reconcile(structure: EffectiveStructure): Promise<ReconcileResult>
  stop(): Promise<void>
}

/**
 * Keeps a generation lease across an approval suspension. A live Turn never
 * switches model/tool/runtime providers midway through configuration reload.
 */
class PinnedAgentLoop implements AgentLoopService {
  readonly #kernel: Kernel
  readonly #suspended = new Map<string, GenerationLease>()

  constructor(kernel: Kernel) {
    this.#kernel = kernel
  }

  async runTurn(input: AgentLoopRunInput): Promise<AgentLoopTurnResult> {
    const lease = this.#kernel.beginTurn()
    try {
      const result = await lease
        .service<AgentLoopService>(AGENT_LOOP_SERVICE)
        .runTurn({
          ...input,
          structureVersion: lease.structureVersion,
        })
      this.#settleLease(result, lease)
      return result
    } catch (error) {
      lease.release()
      throw error
    }
  }

  async recoverTurn(
    input: AgentLoopRecoverInput,
  ): Promise<AgentLoopTurnResult> {
    const lease = this.#suspended.get(input.turnId) ?? this.#kernel.beginTurn()
    try {
      const result = await lease
        .service<AgentLoopService>(AGENT_LOOP_SERVICE)
        .recoverTurn(input)
      this.#settleLease(result, lease)
      return result
    } catch (error) {
      if (!this.#suspended.has(input.turnId)) lease.release()
      throw error
    }
  }

  async resumeTurn(input: AgentLoopResumeInput): Promise<AgentLoopTurnResult> {
    const held = this.#suspended.get(input.turnId)
    const lease = held ?? this.#kernel.beginTurn()
    try {
      const result = await lease
        .service<AgentLoopService>(AGENT_LOOP_SERVICE)
        .resumeTurn(input)
      this.#settleLease(result, lease)
      return result
    } catch (error) {
      if (held === undefined) lease.release()
      throw error
    }
  }

  stop(): void {
    for (const lease of this.#suspended.values()) lease.release()
    this.#suspended.clear()
  }

  #settleLease(result: AgentLoopTurnResult, lease: GenerationLease): void {
    if (result.status === 'suspended') {
      const previous = this.#suspended.get(result.turn.id)
      if (previous !== undefined && previous !== lease) previous.release()
      this.#suspended.set(result.turn.id, lease)
      return
    }
    this.#suspended.delete(result.turn.id)
    lease.release()
  }
}

function servicePlugin(
  id: string,
  serviceName: string,
  value: unknown,
  options: {
    readonly config: unknown
    readonly replacementTier: ReplacementTier
  },
): RuntimePlugin {
  return {
    id,
    version: '1.0.0',
    config: options.config,
    provides: [serviceName],
    replacementTier: options.replacementTier,
    apply(ctx) {
      ctx.provide(serviceName, value)
    },
  }
}

/** Deterministic built-in structure used only when Chronicle has no active one. */
export async function createDefaultBeeStructure(
  options: Pick<BeeKernelRuntimeOptions, 'llm' | 'modelId' | 'toolSpecs'>,
): Promise<EffectiveStructure> {
  return resolveEffectiveStructure(
    BundleSchema.parse({
      id: 'bee-host',
      version: '1.0.0',
      model: {
        id: options.modelId ?? 'host-model',
        version: options.llm.model,
      },
      prompt: { id: 'bee-system', version: '1.0.0' },
      contextPolicy: { id: 'bee-default', version: '1.0.0' },
      memoryView: { id: 'bee-personal', version: '1.0.0' },
      sandbox: { id: 'bee-local', version: '1.0.0' },
      evalPolicy: { id: 'bee-default', version: '1.0.0' },
      tools: options.toolSpecs.map((tool) => ({
        id: tool.id,
        version: '1.0.0',
      })),
    }),
  )
}

function createHostPluginFactories(
  options: BeeKernelRuntimeOptions,
): PluginFactoryRegistry {
  const factories = new PluginFactoryRegistry()
  const defaultModelKey = modelBindingKey(
    options.modelId ?? 'host-model',
    options.llm.model,
  )
  const models = new Map(options.modelProviders)
  models.set(defaultModelKey, options.llm)
  factories.register({
    id: 'bee.host-services',
    create(structure) {
      const selectedModel = models.get(
        modelBindingKey(structure.model.ref.id, structure.model.ref.version),
      )
      if (selectedModel === undefined) {
        throw new Error(
          `No model provider is bound for '${structure.model.ref.id}@${structure.model.ref.version}'`,
        )
      }
      const availableTools = new Set(options.toolSpecs.map((tool) => tool.id))
      const missingTools = structure.tools
        .map((slot) => slot.ref.id)
        .filter((id) => !availableTools.has(id))
      if (missingTools.length > 0) {
        throw new Error(
          `No tool provider is bound for: ${missingTools.join(', ')}`,
        )
      }
      return [
        servicePlugin('bee.chronicle', 'chronicle', options.store, {
          config: { binding: 'host-chronicle' },
          replacementTier: 'c',
        }),
        servicePlugin('bee.kanban', 'kanban', options.kanban, {
          config: { binding: 'host-kanban' },
          replacementTier: 'c',
        }),
        servicePlugin('bee.model', 'llm', selectedModel, {
          config: structure.model.ref,
          replacementTier: 'b',
        }),
        servicePlugin(
          'bee.tool-executor',
          'toolExecutor',
          options.toolExecutor,
          {
            config: structure.tools.map((slot) => slot.ref),
            replacementTier: 'b',
          },
        ),
        servicePlugin(
          'bee.sandbox-policy',
          'sandboxPolicy',
          structure.sandbox.ref,
          {
            config: structure.sandbox.ref,
            replacementTier: 'c',
          },
        ),
      ]
    },
  })
  factories.register({
    id: 'bee.tool-execution',
    create(structure) {
      const enabled = new Set(structure.tools.map((slot) => slot.ref.id))
      return createToolExecutionPlugin({
        rules: options.toolAuthorization.filter((rule) =>
          enabled.has(rule.toolId),
        ),
      })
    },
  })
  factories.register({
    id: 'bee.model-request',
    create(structure) {
      const contextBudget = structure.budgets.find(
        (budget) => budget.name === 'model.contextTokens',
      )?.value
      return createModelRequestPlugin({
        promptVersion: `${structure.prompt.ref.id}@${structure.prompt.ref.version}`,
        structureVersion: structure.digest,
        ...(typeof contextBudget === 'number'
          ? { tokenBudget: contextBudget }
          : {}),
      })
    },
  })
  factories.register({
    id: 'bee.agent-loop',
    create(structure) {
      return {
        ...createAgentLoopPlugin({ toolSpecs: options.toolSpecs }),
        config: {
          prompt: structure.prompt.ref,
          contextPolicy: structure.contextPolicy.ref,
          memoryView: structure.memoryView.ref,
          sandbox: structure.sandbox.ref,
          evalPolicy: structure.evalPolicy.ref,
          permissions: structure.permissions,
          budgets: structure.budgets,
        },
      }
    },
  })
  return factories
}

export function modelBindingKey(id: string, version: string): string {
  return `${id}@${version}`
}

/**
 * Builds the real Host runtime as a Cordis-managed plugin graph. Model,
 * tools, Chronicle, Kanban and AgentLoop are services rather than privileged
 * objects wired directly into Fastify.
 */
export async function createBeeKernelRuntime(
  options: BeeKernelRuntimeOptions,
): Promise<BeeKernelRuntime> {
  const structures = new StructureReconciler({
    store: options.store,
    factories: createHostPluginFactories(options),
  })
  const kernel = structures.kernel
  const result =
    options.effectiveStructure !== undefined
      ? await structures.reconcile(options.effectiveStructure)
      : options.restoreActiveStructure !== false
        ? ((await structures.restore()) ??
          (await structures.reconcile(
            await createDefaultBeeStructure(options),
          )))
        : await structures.reconcile(await createDefaultBeeStructure(options))
  if (result.kind === 'restart-required') {
    throw new Error('Initial Bee Host generation unexpectedly requires restart')
  }
  const loop = new PinnedAgentLoop(kernel)
  return {
    kernel,
    structures,
    loop,
    async reconcile(structure) {
      return structures.reconcile(structure)
    },
    async stop() {
      loop.stop()
      await structures.stop()
    },
  }
}
