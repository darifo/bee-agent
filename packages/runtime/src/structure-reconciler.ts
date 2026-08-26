import { randomUUID } from 'node:crypto'
import {
  createKernel,
  PluginCatalog,
  type EffectiveStructure,
  type Kernel,
  type KernelLifecycleEvent,
  type KernelOptions,
  type PluginGraph,
  type ReconcileResult,
  type RuntimePlugin,
  verifyEffectiveStructure,
} from '@bee-agent/kernel'
import {
  appendResolvedStructure,
  appendStructureLifecycleEvent,
  readActiveStructure,
  type ChronicleStore,
} from '@bee-agent/knowledge'

export interface PluginFactory {
  /** Stable factory identity used for duplicate-registration diagnostics. */
  readonly id: string
  create(
    structure: EffectiveStructure,
  ):
    | RuntimePlugin
    | readonly RuntimePlugin[]
    | null
    | Promise<RuntimePlugin | readonly RuntimePlugin[] | null>
}

/** Ordered registry translating one EffectiveStructure into a PluginGraph. */
export class PluginFactoryRegistry {
  readonly #factories = new Map<string, PluginFactory>()

  register(factory: PluginFactory): () => void {
    if (this.#factories.has(factory.id)) {
      throw new Error(`Plugin factory '${factory.id}' is already registered`)
    }
    this.#factories.set(factory.id, factory)
    return () => {
      if (this.#factories.get(factory.id) === factory) {
        this.#factories.delete(factory.id)
      }
    }
  }

  list(): readonly string[] {
    return [...this.#factories.keys()]
  }

  async createGraph(
    structure: EffectiveStructure,
    catalog?: PluginCatalog,
  ): Promise<PluginGraph> {
    const plugins: RuntimePlugin[] = []
    for (const factory of this.#factories.values()) {
      const created = await factory.create(structure)
      if (created === null) continue
      plugins.push(...(Array.isArray(created) ? created : [created]))
    }
    if (catalog !== undefined) {
      for (const entry of structure.plugins) {
        if (entry.enabled) plugins.push(await catalog.resolve(entry, structure))
      }
    }
    return { structureVersion: structure.digest, plugins }
  }
}

/** Serializes structure-stream appends, including background generation drain. */
class StructureChronicleWriter {
  #tail: Promise<void> = Promise.resolve()

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation)
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  flush(): Promise<void> {
    return this.#tail
  }
}

export interface StructureReconcilerOptions {
  readonly store: ChronicleStore
  readonly factories: PluginFactoryRegistry
  readonly catalog?: PluginCatalog | undefined
  readonly kernel?: Omit<KernelOptions, 'onLifecycleEvent'> | undefined
  readonly onLifecycleEvent?:
    ((event: KernelLifecycleEvent) => void | Promise<void>) | undefined
}

/**
 * Durable desired-state boundary: records resolution, builds the plugin graph,
 * reconciles a candidate generation, and persists every lifecycle transition.
 */
export class StructureReconciler {
  readonly kernel: Kernel
  readonly #store: ChronicleStore
  readonly #factories: PluginFactoryRegistry
  readonly #catalog: PluginCatalog | undefined
  readonly #writer = new StructureChronicleWriter()
  #reconcileTail: Promise<void> = Promise.resolve()
  #activeStructure: EffectiveStructure | undefined

  constructor(options: StructureReconcilerOptions) {
    this.#store = options.store
    this.#factories = options.factories
    this.#catalog = options.catalog ?? new PluginCatalog()
    this.kernel = createKernel({
      ...options.kernel,
      onLifecycleEvent: async (event) => {
        await this.#writer.run(() =>
          appendStructureLifecycleEvent(this.#store, event),
        )
        await options.onLifecycleEvent?.(event)
      },
    })
  }

  get activeStructure(): EffectiveStructure | undefined {
    return this.#activeStructure
  }

  async reconcile(structure: EffectiveStructure): Promise<ReconcileResult> {
    structure = verifyEffectiveStructure(structure)
    const result = this.#reconcileTail.then(
      () => this.#reconcile(structure),
      () => this.#reconcile(structure),
    )
    this.#reconcileTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async #reconcile(structure: EffectiveStructure): Promise<ReconcileResult> {
    await this.#writer.run(() =>
      appendResolvedStructure(this.#store, structure),
    )
    let graph: PluginGraph
    try {
      graph = await this.#factories.createGraph(structure, this.#catalog)
    } catch (error) {
      await this.#writer.run(() =>
        appendStructureLifecycleEvent(this.#store, {
          type: 'generation.failed',
          generationId: randomUUID(),
          structureVersion: structure.digest,
          error,
        }),
      )
      throw error
    }
    const result = await this.kernel.reconcile(graph)
    if (result.kind !== 'restart-required') this.#activeStructure = structure
    return result
  }

  /** Rebuilds the latest successfully activated structure, if one exists. */
  async restore(): Promise<ReconcileResult | undefined> {
    await this.#reconcileTail
    await this.#writer.flush()
    const structure = await readActiveStructure(this.#store)
    if (structure === undefined) return undefined
    return this.reconcile(structure)
  }

  async stop(): Promise<void> {
    await this.#reconcileTail
    await this.kernel.stop()
    await this.#writer.flush()
    this.#activeStructure = undefined
  }
}
