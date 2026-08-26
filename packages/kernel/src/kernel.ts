import { createHash, randomUUID } from 'node:crypto'
import { Context } from './cordis/context.ts'
import type { Effect, Fiber } from './cordis/fiber.ts'
import type { Inject, Plugin } from './cordis/registry.ts'
import { canonicalJson } from './structure.ts'

export const REPLACEMENT_TIERS = ['a', 'b', 'c'] as const
export type ReplacementTier = (typeof REPLACEMENT_TIERS)[number]

/** A plugin in the desired runtime graph. */
export interface RuntimePlugin<T = unknown> {
  readonly id: string
  readonly version: string
  readonly config?: T | undefined
  readonly inject?: readonly string[] | undefined
  readonly provides?: readonly string[] | undefined
  readonly replacementTier?: ReplacementTier | undefined
  apply(ctx: Context, config: T): Effect | void
  healthCheck?(ctx: Context): Promise<PluginHealth> | PluginHealth
}

export interface PluginHealth {
  readonly status: 'healthy' | 'degraded' | 'unhealthy'
  readonly detail?: string | undefined
}

export type FiberStatus =
  'pending' | 'loading' | 'active' | 'failed' | 'unloading' | 'disposed'

export interface FiberSnapshot {
  readonly pluginId: string
  readonly pluginVersion: string
  readonly fiberId: number | null
  readonly status: FiberStatus
  readonly injectedServices: readonly string[]
  readonly providedServices: readonly string[]
  readonly effectLabels: readonly string[]
}

export interface RuntimeGraphSnapshot {
  readonly generationId: string
  readonly structureVersion: string
  readonly state: StructureGenerationState
  readonly references: number
  readonly fibers: readonly FiberSnapshot[]
}

export interface QuarantineSnapshot {
  readonly generationId: string
  readonly structureVersion: string
  readonly error: string
  readonly recordedAt: string
}

export interface KernelDoctorIssue {
  readonly severity: 'warning' | 'error'
  readonly code: 'restart-required' | 'generation-draining' | 'cleanup-failed'
  readonly detail: string
}

export interface KernelDoctorReport {
  readonly healthy: boolean
  readonly activeGenerationId: string | null
  readonly restartRequiredPlugins: readonly string[]
  readonly generations: readonly RuntimeGraphSnapshot[]
  readonly quarantines: readonly QuarantineSnapshot[]
  readonly issues: readonly KernelDoctorIssue[]
}

export interface PluginGraph {
  readonly structureVersion: string
  readonly plugins: readonly RuntimePlugin[]
}

export class MissingPluginDependencyError extends Error {
  constructor(
    readonly pluginId: string,
    readonly serviceName: string,
  ) {
    super(`Plugin '${pluginId}' requires missing service '${serviceName}'`)
    this.name = 'MissingPluginDependencyError'
  }
}

export class PluginDependencyCycleError extends Error {
  constructor(readonly pluginIds: readonly string[]) {
    super(`Plugin dependency cycle: ${pluginIds.join(' -> ')}`)
    this.name = 'PluginDependencyCycleError'
  }
}

export class DuplicateServiceProviderError extends Error {
  constructor(
    readonly serviceName: string,
    readonly providers: readonly string[],
  ) {
    super(
      `Service '${serviceName}' has multiple providers: ${providers.join(', ')}`,
    )
    this.name = 'DuplicateServiceProviderError'
  }
}

export class StructureVersionCollisionError extends Error {
  constructor(readonly structureVersion: string) {
    super(
      `Structure version '${structureVersion}' was reused for a different plugin graph`,
    )
    this.name = 'StructureVersionCollisionError'
  }
}

export class PluginActivationError extends Error {
  constructor(
    readonly pluginId: string,
    options: { cause: unknown },
  ) {
    const detail =
      options.cause instanceof Error ? `: ${options.cause.message}` : ''
    super(`Plugin '${pluginId}' failed to activate${detail}`, options)
    this.name = 'PluginActivationError'
  }
}

export class NoActiveStructureGenerationError extends Error {
  constructor() {
    super('No active structure generation')
    this.name = 'NoActiveStructureGenerationError'
  }
}

export class RestrictedServiceAccessError extends Error {
  constructor(readonly serviceName: string) {
    super(`Service '${serviceName}' is not visible in this context scope`)
    this.name = 'RestrictedServiceAccessError'
  }
}

/**
 * Monotonic service-visibility policy for derived Turn/Subagent/Tool scopes.
 * A child policy may only remove services that its parent allowed.
 */
export class ContextPolicy {
  readonly #allowed: ReadonlySet<string> | undefined

  constructor(allowed?: Iterable<string>) {
    this.#allowed = allowed === undefined ? undefined : new Set(allowed)
  }

  static unrestricted(): ContextPolicy {
    return new ContextPolicy()
  }

  canResolve(serviceName: string): boolean {
    return this.#allowed?.has(serviceName) ?? true
  }

  restrict(allowed: Iterable<string>): ContextPolicy {
    const requested = new Set(allowed)
    if (this.#allowed === undefined) return new ContextPolicy(requested)
    return new ContextPolicy(
      [...requested].filter((name) => this.#allowed?.has(name)),
    )
  }
}

/** A scoped, policy-checked view of a Cordis Context. */
export class ContextScope {
  constructor(
    readonly context: Context,
    readonly policy: ContextPolicy = ContextPolicy.unrestricted(),
  ) {}

  service<T>(name: string): T {
    if (!this.policy.canResolve(name)) {
      throw new RestrictedServiceAccessError(name)
    }
    const service = this.context.get(name)
    if (service === undefined) {
      throw new MissingPluginDependencyError('context-scope', name)
    }
    return service as T
  }

  derive(allowedServices: Iterable<string>): ContextScope {
    return new ContextScope(
      this.context.extend(),
      this.policy.restrict(allowedServices),
    )
  }

  isolate(serviceName: string, label?: symbol): ContextScope {
    if (!this.policy.canResolve(serviceName)) {
      throw new RestrictedServiceAccessError(serviceName)
    }
    return new ContextScope(
      this.context.isolate(serviceName, label),
      this.policy,
    )
  }
}

interface MountedPlugin {
  spec: RuntimePlugin
  readonly fiber: Fiber
}

export interface PluginChange {
  readonly pluginId: string
  readonly kind: 'added' | 'removed' | 'configured' | 'replaced'
  readonly tier: ReplacementTier
}

export interface ReconcilePlan {
  readonly kind:
    'unchanged' | 'live-update' | 'generation-swap' | 'restart-required'
  readonly changes: readonly PluginChange[]
}

function configDigest(config: unknown): string {
  return `sha256:${createHash('sha256')
    .update(canonicalJson(config ?? null))
    .digest('hex')}`
}

function stateName(state: number, uid: number | null): FiberStatus {
  if (uid === null) return 'disposed'
  switch (state) {
    case 0:
      return 'pending'
    case 1:
      return 'loading'
    case 2:
      return 'active'
    case 3:
      return 'failed'
    case 5:
      return 'unloading'
    default:
      return 'disposed'
  }
}

function effectLabels(fiber: Fiber): readonly string[] {
  return fiber.getEffects().map((effect) => effect.label)
}

function validateAndOrder(
  specs: readonly RuntimePlugin[],
  bootstrapServices: ReadonlySet<string>,
): readonly RuntimePlugin[] {
  const byId = new Map<string, RuntimePlugin>()
  const providers = new Map<string, string>()

  for (const spec of specs) {
    if (byId.has(spec.id)) {
      throw new Error(`Plugin '${spec.id}' appears more than once`)
    }
    byId.set(spec.id, spec)
    for (const service of spec.provides ?? []) {
      const existing = providers.get(service)
      if (existing !== undefined) {
        throw new DuplicateServiceProviderError(service, [existing, spec.id])
      }
      providers.set(service, spec.id)
    }
  }

  const dependencies = new Map<string, Set<string>>()
  for (const spec of specs) {
    const edges = new Set<string>()
    for (const service of spec.inject ?? []) {
      const provider = providers.get(service)
      if (provider !== undefined) edges.add(provider)
      else if (!bootstrapServices.has(service)) {
        throw new MissingPluginDependencyError(spec.id, service)
      }
    }
    dependencies.set(spec.id, edges)
  }

  const ordered: RuntimePlugin[] = []
  const temporary = new Set<string>()
  const permanent = new Set<string>()
  const visit = (id: string, path: readonly string[]): void => {
    if (permanent.has(id)) return
    if (temporary.has(id)) {
      const start = path.indexOf(id)
      throw new PluginDependencyCycleError([...path.slice(start), id])
    }
    temporary.add(id)
    for (const dependency of dependencies.get(id) ?? []) {
      visit(dependency, [...path, id])
    }
    temporary.delete(id)
    permanent.add(id)
    ordered.push(byId.get(id) as RuntimePlugin)
  }
  for (const spec of specs) visit(spec.id, [])
  return ordered
}

export type StructureGenerationState =
  'preparing' | 'active' | 'draining' | 'disposed' | 'failed'

/**
 * One versioned, reference-counted runtime graph. New generations are built
 * and health-checked before activation; old generations remain alive while
 * Turns still reference them. Only config-only tier-A updates may reuse a
 * generation, and only while its reference count is zero.
 */
export class StructureGeneration {
  readonly id = randomUUID()
  readonly context = new Context()
  structureVersion: string
  graphDigest: string
  #plugins: readonly RuntimePlugin[]
  readonly #bootstrap: ReadonlyMap<string, unknown>
  readonly #mounted: MountedPlugin[] = []
  readonly #onDisposed:
    | ((generation: StructureGeneration, error?: Error) => void | Promise<void>)
    | undefined
  #references = 0
  #state: StructureGenerationState = 'preparing'
  #disposeTask: Promise<void> | undefined

  constructor(
    graph: PluginGraph,
    bootstrap: ReadonlyMap<string, unknown> = new Map(),
    onDisposed?: (
      generation: StructureGeneration,
      error?: Error,
    ) => void | Promise<void>,
  ) {
    this.structureVersion = graph.structureVersion
    this.graphDigest = pluginGraphDigest(graph.plugins)
    this.#bootstrap = bootstrap
    this.#onDisposed = onDisposed
    this.#plugins = validateAndOrder(graph.plugins, new Set(bootstrap.keys()))
  }

  get state(): StructureGenerationState {
    return this.#state
  }

  get references(): number {
    return this.#references
  }

  async prepare(): Promise<void> {
    if (this.#state !== 'preparing') return
    try {
      for (const [name, service] of this.#bootstrap) {
        this.context.provide(name, service)
      }
      for (const spec of this.#plugins) {
        const callback: Plugin.Function<unknown> = (ctx, config) =>
          spec.apply(ctx, config)
        Object.defineProperty(callback, 'name', {
          configurable: true,
          value: spec.id,
        })
        callback.inject = [...(spec.inject ?? [])] satisfies Inject
        if (spec.provides !== undefined) {
          callback.provide = [...spec.provides]
        }
        const fiber = this.context.plugin(callback, spec.config)
        try {
          await fiber
        } catch (error) {
          throw new PluginActivationError(spec.id, { cause: error })
        }
        const health = await spec.healthCheck?.(fiber.ctx)
        if (health?.status === 'unhealthy') {
          throw new PluginActivationError(spec.id, {
            cause: new Error(health.detail ?? 'unhealthy'),
          })
        }
        this.#mounted.push({ spec, fiber })
      }
    } catch (error) {
      this.#state = 'failed'
      await this.dispose()
      throw error
    }
  }

  activate(): void {
    if (this.#state !== 'preparing') {
      throw new Error(
        `Cannot activate generation '${this.id}' in state '${this.#state}'`,
      )
    }
    this.#state = 'active'
  }

  acquire(policy = ContextPolicy.unrestricted()): GenerationLease {
    if (this.#state !== 'active' && this.#state !== 'draining') {
      throw new Error(
        `Cannot acquire generation '${this.id}' in state '${this.#state}'`,
      )
    }
    this.#references += 1
    return new GenerationLease(this, new ContextScope(this.context, policy))
  }

  async drain(): Promise<void> {
    if (this.#state === 'disposed') return
    if (this.#state === 'active') this.#state = 'draining'
    if (this.#references === 0) await this.dispose()
  }

  release(): void {
    if (this.#references === 0) return
    this.#references -= 1
    if (this.#references === 0 && this.#state === 'draining') {
      void this.dispose().catch((error) => this.context.logger.error(error))
    }
  }

  dispose(): Promise<void> {
    this.#disposeTask ??= this.#dispose()
    return this.#disposeTask
  }

  inspect(): RuntimeGraphSnapshot {
    return {
      generationId: this.id,
      structureVersion: this.structureVersion,
      state: this.#state,
      references: this.#references,
      fibers: this.#mounted.map(({ spec, fiber }) => ({
        pluginId: spec.id,
        pluginVersion: spec.version,
        fiberId: fiber.uid,
        status: stateName(fiber.state, fiber.uid),
        injectedServices: [...(spec.inject ?? [])],
        providedServices: [...(spec.provides ?? [])],
        effectLabels: effectLabels(fiber),
      })),
    }
  }

  digest(): string {
    return this.graphDigest
  }

  restartRequiredPlugins(next: readonly RuntimePlugin[]): readonly string[] {
    return this.plan(next)
      .changes.filter(({ tier }) => tier === 'c')
      .map(({ pluginId }) => pluginId)
  }

  plan(next: readonly RuntimePlugin[]): ReconcilePlan {
    return createReconcilePlan(this.#plugins, next)
  }

  /** Apply a config-only A-tier update when no Turn pins this generation. */
  async updateInPlace(graph: PluginGraph): Promise<void> {
    const ordered = validateAndOrder(
      graph.plugins,
      new Set(this.#bootstrap.keys()),
    )
    const plan = this.plan(ordered)
    if (plan.kind !== 'live-update' || this.#references !== 0) {
      throw new Error(`Generation '${this.id}' is not eligible for live update`)
    }
    const incoming = new Map(ordered.map((plugin) => [plugin.id, plugin]))
    const updated: Array<{ mounted: MountedPlugin; before: RuntimePlugin }> = []
    try {
      for (const mounted of this.#mounted) {
        const after = incoming.get(mounted.spec.id)
        if (
          after === undefined ||
          pluginDescriptorDigest(after) === pluginDescriptorDigest(mounted.spec)
        ) {
          continue
        }
        const before = mounted.spec
        updated.push({ mounted, before })
        await mounted.fiber.update(after.config, true)
        mounted.spec = after
      }
      for (const mounted of this.#mounted) {
        await mounted.fiber
        const health = await mounted.spec.healthCheck?.(mounted.fiber.ctx)
        if (health?.status === 'unhealthy') {
          throw new Error(
            health.detail ?? `Plugin '${mounted.spec.id}' is unhealthy`,
          )
        }
      }
    } catch (error) {
      const rollbackFailures: unknown[] = []
      for (const { mounted, before } of updated.reverse()) {
        try {
          await mounted.fiber.update(before.config, true)
          mounted.spec = before
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError)
        }
      }
      for (const mounted of this.#mounted) {
        try {
          await mounted.fiber
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError)
        }
      }
      if (rollbackFailures.length > 0) {
        throw new AggregateError(
          [error, ...rollbackFailures],
          `Generation '${this.id}' live update and rollback failed`,
        )
      }
      throw error
    }
    this.#plugins = ordered
    this.structureVersion = graph.structureVersion
    this.graphDigest = pluginGraphDigest(graph.plugins)
  }

  async #dispose(): Promise<void> {
    const failures: unknown[] = []
    for (const { fiber } of [...this.#mounted].reverse()) {
      try {
        await fiber.dispose()
        failures.push(...fiber.consumeCleanupErrors())
      } catch (error) {
        failures.push(error)
      }
    }
    this.#mounted.length = 0
    this.#state = 'disposed'
    const disposalError =
      failures.length > 0
        ? new AggregateError(
            failures,
            `Generation '${this.id}' failed to dispose cleanly`,
          )
        : undefined
    try {
      await this.#onDisposed?.(this, disposalError)
    } catch (error) {
      failures.push(error)
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Generation '${this.id}' failed to dispose cleanly`,
      )
    }
  }
}

export class GenerationLease implements AsyncDisposable {
  #released = false

  constructor(
    readonly generation: StructureGeneration,
    readonly scope: ContextScope,
  ) {}

  get structureVersion(): string {
    return this.generation.structureVersion
  }

  service<T>(name: string): T {
    return this.scope.service<T>(name)
  }

  release(): void {
    if (this.#released) return
    this.#released = true
    this.generation.release()
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.release()
  }
}

export type KernelLifecycleEvent =
  | {
      readonly type:
        'generation.prepared' | 'generation.activated' | 'generation.updated'
      readonly generationId: string
      readonly structureVersion: string
    }
  | {
      readonly type: 'generation.failed'
      readonly generationId: string
      readonly structureVersion: string
      readonly error: unknown
    }
  | {
      readonly type: 'generation.draining' | 'generation.disposed'
      readonly generationId: string
      readonly structureVersion: string
    }
  | {
      readonly type: 'generation.restart_required'
      readonly generationId: string
      readonly structureVersion: string
      readonly pluginIds: readonly string[]
    }

export interface KernelOptions {
  readonly bootstrapServices?: ReadonlyMap<string, unknown> | undefined
  readonly onLifecycleEvent?:
    ((event: KernelLifecycleEvent) => void | Promise<void>) | undefined
}

export type ReconcileResult =
  | {
      readonly kind: 'activated'
      readonly generation: StructureGeneration
      readonly previous?: StructureGeneration | undefined
    }
  | {
      readonly kind: 'unchanged'
      readonly generation: StructureGeneration
    }
  | {
      readonly kind: 'updated'
      readonly generation: StructureGeneration
    }
  | {
      readonly kind: 'restart-required'
      readonly pluginIds: readonly string[]
    }

/**
 * Bee's canonical Cordis-backed kernel. Cordis manages live fibers and
 * reactive services; this wrapper adds immutable, reference-counted runtime
 * generations so configuration changes never mutate an executing Turn.
 */
export class Kernel {
  readonly #options: KernelOptions
  readonly #generations = new Map<string, StructureGeneration>()
  readonly #quarantines = new Map<string, QuarantineSnapshot>()
  #active: StructureGeneration | undefined
  #restartRequiredPlugins: readonly string[] = []

  constructor(options: KernelOptions = {}) {
    this.#options = options
  }

  get activeGeneration(): StructureGeneration | undefined {
    return this.#active
  }

  get restartRequired(): boolean {
    return this.#restartRequiredPlugins.length > 0
  }

  get restartRequiredPlugins(): readonly string[] {
    return this.#restartRequiredPlugins
  }

  async reconcile(graph: PluginGraph): Promise<ReconcileResult> {
    if (this.#active?.structureVersion === graph.structureVersion) {
      if (this.#active.graphDigest !== pluginGraphDigest(graph.plugins)) {
        throw new StructureVersionCollisionError(graph.structureVersion)
      }
      this.#restartRequiredPlugins = []
      return { kind: 'unchanged', generation: this.#active }
    }
    if (this.#active !== undefined) {
      const plan = this.#active.plan(graph.plugins)
      const tierC = plan.changes
        .filter(({ tier }) => tier === 'c')
        .map(({ pluginId }) => pluginId)
      if (tierC.length > 0) {
        this.#restartRequiredPlugins = tierC
        await this.#emit({
          type: 'generation.restart_required',
          generationId: this.#active.id,
          structureVersion: graph.structureVersion,
          pluginIds: tierC,
        })
        return { kind: 'restart-required', pluginIds: tierC }
      }
      if (plan.kind === 'live-update' && this.#active.references === 0) {
        try {
          await this.#active.updateInPlace(graph)
        } catch (error) {
          await this.#emit({
            type: 'generation.failed',
            generationId: this.#active.id,
            structureVersion: graph.structureVersion,
            error,
          })
          throw error
        }
        this.#restartRequiredPlugins = []
        await this.#emit({
          type: 'generation.updated',
          generationId: this.#active.id,
          structureVersion: graph.structureVersion,
        })
        return { kind: 'updated', generation: this.#active }
      }
    }

    const candidate = new StructureGeneration(
      graph,
      this.#options.bootstrapServices,
      async (generation, disposalError) => {
        this.#generations.delete(generation.id)
        if (disposalError !== undefined) {
          this.#quarantines.set(generation.id, {
            generationId: generation.id,
            structureVersion: generation.structureVersion,
            error: disposalError.message,
            recordedAt: new Date().toISOString(),
          })
        }
        await this.#emit({
          type: 'generation.disposed',
          generationId: generation.id,
          structureVersion: generation.structureVersion,
        })
      },
    )
    this.#generations.set(candidate.id, candidate)
    try {
      await candidate.prepare()
      await this.#emit({
        type: 'generation.prepared',
        generationId: candidate.id,
        structureVersion: candidate.structureVersion,
      })
      candidate.activate()
      const previous = this.#active
      this.#active = candidate
      this.#restartRequiredPlugins = []
      await this.#emit({
        type: 'generation.activated',
        generationId: candidate.id,
        structureVersion: candidate.structureVersion,
      })
      if (previous !== undefined) {
        await this.#emit({
          type: 'generation.draining',
          generationId: previous.id,
          structureVersion: previous.structureVersion,
        })
        try {
          await previous.drain()
        } catch (error) {
          previous.context.logger.error(error)
        }
      }
      return { kind: 'activated', generation: candidate, previous }
    } catch (error) {
      await this.#emit({
        type: 'generation.failed',
        generationId: candidate.id,
        structureVersion: candidate.structureVersion,
        error,
      })
      this.#generations.delete(candidate.id)
      throw error
    }
  }

  beginTurn(policy?: ContextPolicy): GenerationLease {
    if (this.#active === undefined) {
      throw new NoActiveStructureGenerationError()
    }
    return this.#active.acquire(policy)
  }

  service<T>(name: string): T {
    const lease = this.beginTurn()
    try {
      return lease.service<T>(name)
    } finally {
      lease.release()
    }
  }

  inspect(): readonly RuntimeGraphSnapshot[] {
    return [...this.#generations.values()].map((generation) =>
      generation.inspect(),
    )
  }

  doctor(): KernelDoctorReport {
    const generations = this.inspect()
    const quarantines = [...this.#quarantines.values()]
    const issues: KernelDoctorIssue[] = []
    if (this.#restartRequiredPlugins.length > 0) {
      issues.push({
        severity: 'warning',
        code: 'restart-required',
        detail: `Process restart required by: ${this.#restartRequiredPlugins.join(', ')}`,
      })
    }
    for (const generation of generations) {
      if (generation.state === 'draining' && generation.references > 0) {
        issues.push({
          severity: 'warning',
          code: 'generation-draining',
          detail: `Generation '${generation.generationId}' is pinned by ${generation.references} Turn(s)`,
        })
      }
    }
    for (const quarantine of quarantines) {
      issues.push({
        severity: 'error',
        code: 'cleanup-failed',
        detail: `Generation '${quarantine.generationId}': ${quarantine.error}`,
      })
    }
    return {
      healthy: issues.every(({ severity }) => severity !== 'error'),
      activeGenerationId: this.#active?.id ?? null,
      restartRequiredPlugins: [...this.#restartRequiredPlugins],
      generations,
      quarantines,
      issues,
    }
  }

  async stop(): Promise<void> {
    const failures: unknown[] = []
    for (const generation of [...this.#generations.values()].reverse()) {
      try {
        await generation.drain()
        await generation.dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    this.#generations.clear()
    this.#active = undefined
    this.#restartRequiredPlugins = []
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Kernel stop failed')
    }
  }

  async #emit(event: KernelLifecycleEvent): Promise<void> {
    await this.#options.onLifecycleEvent?.(event)
  }
}

function pluginGraphDigest(plugins: readonly RuntimePlugin[]): string {
  return configDigest(plugins.map(pluginDescriptor))
}

function pluginDescriptor(plugin: RuntimePlugin): unknown {
  return {
    id: plugin.id,
    version: plugin.version,
    config: plugin.config,
    inject: plugin.inject,
    provides: plugin.provides,
    replacementTier: plugin.replacementTier,
  }
}

function pluginDescriptorDigest(plugin: RuntimePlugin): string {
  return configDigest(pluginDescriptor(plugin))
}

function replacementTier(
  before: RuntimePlugin | undefined,
  after: RuntimePlugin | undefined,
): ReplacementTier {
  const tiers = [before?.replacementTier ?? 'b', after?.replacementTier ?? 'b']
  if (tiers.includes('c')) return 'c'
  if (tiers.includes('b')) return 'b'
  return 'a'
}

function topologyDescriptor(plugin: RuntimePlugin): unknown {
  return {
    id: plugin.id,
    version: plugin.version,
    inject: plugin.inject,
    provides: plugin.provides,
  }
}

export function createReconcilePlan(
  current: readonly RuntimePlugin[],
  incoming: readonly RuntimePlugin[],
): ReconcilePlan {
  const beforeById = new Map(current.map((plugin) => [plugin.id, plugin]))
  const afterById = new Map(incoming.map((plugin) => [plugin.id, plugin]))
  const ids = new Set([...beforeById.keys(), ...afterById.keys()])
  const changes: PluginChange[] = []
  for (const pluginId of ids) {
    const before = beforeById.get(pluginId)
    const after = afterById.get(pluginId)
    if (
      before !== undefined &&
      after !== undefined &&
      pluginDescriptorDigest(before) === pluginDescriptorDigest(after)
    ) {
      continue
    }
    let tier = replacementTier(before, after)
    let kind: PluginChange['kind']
    if (before === undefined) kind = 'added'
    else if (after === undefined) kind = 'removed'
    else if (
      canonicalJson(topologyDescriptor(before)) ===
      canonicalJson(topologyDescriptor(after))
    ) {
      kind = 'configured'
    } else {
      kind = 'replaced'
      if (tier === 'a') tier = 'b'
    }
    if ((kind === 'added' || kind === 'removed') && tier === 'a') tier = 'b'
    changes.push({ pluginId, kind, tier })
  }
  if (changes.length === 0) return { kind: 'unchanged', changes }
  if (changes.some(({ tier }) => tier === 'c')) {
    return { kind: 'restart-required', changes }
  }
  if (
    changes.every(({ tier, kind }) => tier === 'a' && kind === 'configured')
  ) {
    return { kind: 'live-update', changes }
  }
  return { kind: 'generation-swap', changes }
}

export function createKernel(options: KernelOptions = {}): Kernel {
  return new Kernel(options)
}
