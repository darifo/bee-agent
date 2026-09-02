import type { ChronicleStore, MemoryProvider } from '@bee-agent/knowledge'
import type { KanbanStore } from '@bee-agent/kanban'
import {
  BundleSchema,
  resolveEffectiveStructure,
  type EffectiveStructure,
  type GenerationLease,
  type Kernel,
  type PluginCatalog,
  type ReconcileResult,
  type ReplacementTier,
  type RuntimePlugin,
} from '@bee-agent/kernel'
import type {
  AgentLoopRecoverInput,
  AgentLoopRetrieveHook,
  LlmMessage,
  AgentLoopResumeInput,
  AgentLoopRunInput,
  AgentLoopTurnResult,
  ConfigSource,
  GoalPlanStore,
  LlmRuntime,
  LlmToolSpec,
  SandboxProvider,
  SecretBroker,
  ToolAuthorizationRule,
  ToolExecutor,
} from '@bee-agent/runtime'
import {
  AGENT_LOOP_SERVICE,
  MemoryDerivationWorker,
  PluginFactoryRegistry,
  RememberingAgentLoop,
  StructureReconciler,
  StructureConfigController,
  createAgentLoopPlugin,
  createGoalPlanHook,
  createMemoryRetrieveHook,
  createTimeRetrieveHook,
  type TimeService,
  type UserGrantStore,
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
  readonly sandboxProvider?: SandboxProvider | undefined
  readonly secretBroker?: SecretBroker | undefined
  /**
   * Personal memory provider. When present, recall runs as the AgentLoop
   * retrieve hook and completed Turns feed the near-line derivation worker.
   */
  readonly memory?: MemoryProvider | undefined
  /** Accurate clock: per-request time injection + the built-in time_now tool. */
  readonly time?: TimeService | undefined
  /** Durable user grants; remembered approvals relax ask to allow. */
  readonly grantStore?: UserGrantStore | undefined
  /** Disable near-line derivation while keeping recall (default: enabled). */
  readonly deriveMemory?: boolean | undefined
  /** Optional Goal/Plan store; complex turns surface a plan via the plan hook. */
  readonly goalPlanStore?: GoalPlanStore | undefined
  /**
   * System message prepended to every model request. When absent, the Host's
   * default Bee prompt (or `BEE_AGENT_SYSTEM_PROMPT`) applies; sections stay
   * memoized so the prefix is cache-stable.
   */
  readonly systemPrompt?: string | undefined
  readonly effectiveStructure?: EffectiveStructure | undefined
  readonly modelId?: string | undefined
  /** Additional providers keyed by `<structure model id>@<model version>`. */
  readonly modelProviders?: ReadonlyMap<string, LlmRuntime> | undefined
  /** Trusted external plugins available to Bundle `plugins` entries. */
  readonly pluginCatalog?: PluginCatalog | undefined
  /** Optional watched desired-state source; failures retain the current generation. */
  readonly configSource?: ConfigSource | undefined
  readonly restoreActiveStructure?: boolean | undefined
}

export interface BeeKernelRuntime {
  readonly kernel: Kernel
  readonly structures: StructureReconciler
  readonly configController: StructureConfigController | undefined
  readonly loop: AgentLoopService & { stop(): void }
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
      permissions: options.toolSpecs.map((tool) => `tool:${tool.id}`),
    }),
  )
}

function sameGrants(
  restored: EffectiveStructure,
  desired: EffectiveStructure,
): boolean {
  const a = restored.permissions.map((permission) => permission.name).sort()
  const b = desired.permissions.map((permission) => permission.name).sort()
  return a.length === b.length && a.every((value, i) => value === b[i])
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
      const modelKey = modelBindingKey(
        structure.model.ref.id,
        structure.model.ref.version,
      )
      const selectedModel =
        models.get(modelKey) ??
        // The default host-model slot always binds the env-provided runtime:
        // a persisted structure can pin a stale model version (the user
        // changed BEE_AGENT_MODEL_NAME), and that must not wedge startup.
        // Other model ids stay fail-closed.
        (structure.model.ref.id === (options.modelId ?? 'host-model')
          ? options.llm
          : undefined)
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
        ...(options.memory === undefined
          ? []
          : [
              servicePlugin('bee.memory', 'memory', options.memory, {
                config: structure.memoryView.ref,
                replacementTier: 'b',
              }),
            ]),
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
        structureGrants: structure.permissions.map(
          (permission) => permission.name,
        ),
        sandbox: options.sandboxProvider,
        secrets: options.secretBroker,
        ...(options.grantStore === undefined
          ? {}
          : { persistedGrants: options.grantStore.granted }),
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
      // Retrieve hooks compose: the accurate clock first (so the model sees
      // "now" even when memory is unavailable), then memory recall. The
      // AgentLoop calls the composed hook before every model request, which
      // is what keeps the injected time fresh on every step.
      const retrieveHooks = [
        ...(options.time === undefined
          ? []
          : [createTimeRetrieveHook(options.time)]),
        ...(options.memory === undefined
          ? []
          : [createMemoryRetrieveHook(options.memory)]),
      ]
      const retrieve =
        retrieveHooks.length === 0
          ? undefined
          : {
              async retrieve(
                input: Parameters<AgentLoopRetrieveHook['retrieve']>[0],
              ): Promise<
                Awaited<ReturnType<AgentLoopRetrieveHook['retrieve']>>
              > {
                const messages: LlmMessage[] = []
                for (const hook of retrieveHooks) {
                  messages.push(...(await hook.retrieve(input)))
                }
                return messages
              },
            }
      const plan =
        options.goalPlanStore === undefined
          ? undefined
          : createGoalPlanHook(options.goalPlanStore)
      return {
        ...createAgentLoopPlugin({
          toolSpecs: options.toolSpecs,
          ...(options.systemPrompt === undefined
            ? {}
            : { systemPrompt: options.systemPrompt }),
          ...(retrieve === undefined && plan === undefined
            ? {}
            : {
                hooks: {
                  ...(retrieve === undefined ? {} : { retrieve }),
                  ...(plan === undefined ? {} : { plan }),
                },
              }),
        }),
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
  await options.grantStore?.rebuild()
  const structures = new StructureReconciler({
    store: options.store,
    factories: createHostPluginFactories(options),
    catalog: options.pluginCatalog,
  })
  const kernel = structures.kernel
  let result: Awaited<ReturnType<typeof structures.reconcile>>
  if (options.effectiveStructure !== undefined) {
    result = await structures.reconcile(options.effectiveStructure)
  } else {
    // Restoring the last activated structure keeps generations stable across
    // restarts — model slots reconciled at runtime stay restored. But the
    // tool list is host-owned configuration: when the restored structure's
    // granted capabilities no longer match the configured tools (a tool was
    // added or removed), the desired structure supersedes it, otherwise the
    // structure-grant layer would keep denying capabilities the host just
    // configured.
    const desired = await createDefaultBeeStructure(options)
    const restored =
      options.restoreActiveStructure === false
        ? undefined
        : await structures.restore()
    const grantsMatch =
      restored !== undefined &&
      structures.activeStructure !== undefined &&
      sameGrants(structures.activeStructure, desired)
    result =
      restored === undefined || !grantsMatch
        ? await structures.reconcile(desired)
        : restored
  }
  if (result.kind === 'restart-required') {
    throw new Error('Initial Bee Host generation unexpectedly requires restart')
  }
  const pinned = new PinnedAgentLoop(kernel)
  const loop: BeeKernelRuntime['loop'] =
    options.memory !== undefined && options.deriveMemory !== false
      ? new RememberingAgentLoop(
          pinned,
          new MemoryDerivationWorker({
            store: options.store,
            provider: options.memory,
          }),
        )
      : pinned
  const configController =
    options.configSource === undefined
      ? undefined
      : new StructureConfigController(options.configSource, structures)
  await configController?.start()
  return {
    kernel,
    structures,
    configController,
    loop,
    async reconcile(structure) {
      return structures.reconcile(structure)
    },
    async stop() {
      await configController?.stop()
      loop.stop()
      await structures.stop()
    },
  }
}
