import type { Context } from './context.ts'
import type { EventBusChild } from './events.ts'
import type { EffectScope } from './effects.ts'
import type { ReplacementTier } from './replacement.ts'
import type { BeeAgentPlugin } from './plugin.ts'

export interface KernelConfig {
  baseDir?: string
  /**
   * Application configuration kept on the Cordis root context (exposed as
   * `Kernel.config`). Mounted plugins receive their own config through mount
   * options; schema validation and profile assembly belong to the composition
   * roots.
   */
  config?: Record<string, unknown>
}

export type KernelState =
  'created' | 'starting' | 'started' | 'stopping' | 'stopped'

export interface TaskScope {
  readonly id: string
  readonly context: Context
  readonly disposed: boolean
  /**
   * Disposes the scope: releases every registered effect in reverse
   * registration order, then tears down the underlying context. Failures are
   * aggregated and rethrown after teardown completed.
   */
  dispose(): Promise<void>
  /**
   * Registers a cleanup callback released when the scope is disposed, either
   * through {@link TaskScope.dispose}, {@link Kernel.disposeTaskScope}, or
   * kernel shutdown. Callbacks run in reverse registration order via
   * {@link TaskScope.effects}. Returns a function that unregisters the
   * callback.
   */
  onDispose(callback: () => void | Promise<void>): () => void
  /** The reversible-effect registry backing {@link onDispose}. */
  readonly effects: EffectScope
  /**
   * Scope-bound view over the kernel domain event bus. Registrations made
   * through it are removed automatically when the scope is disposed.
   */
  readonly events: EventBusChild
  /**
   * Gives this scope its own service slot for `name`, so plugins inside the
   * scope register and resolve a scope-local implementation instead of the
   * global one. Scopes that pass the same `realm` symbol share one slot.
   */
  isolateService(name: string, realm?: symbol): void
}

/**
 * A typed handle for a kernel service name. Use {@link defineServiceKey} so
 * that {@link Kernel.getService} and {@link Kernel.waitForService} infer the
 * service type instead of relying on bare strings.
 */
export interface ServiceKey<T> {
  readonly __serviceType: T
  readonly name: string
}

export function defineServiceKey<T>(name: string): ServiceKey<T> {
  return { name } as ServiceKey<T>
}

export type ServiceKeyLike<T> = string | ServiceKey<T>

export function serviceName<T>(key: ServiceKeyLike<T>): string {
  return typeof key === 'string' ? key : key.name
}

export interface StateChangedEvent {
  readonly from: KernelState
  readonly to: KernelState
}

export interface ServiceRegisteredEvent {
  readonly name: string
  readonly service: unknown
}

export interface ServiceUnregisteredEvent {
  readonly name: string
}

export interface TaskScopeEvent {
  readonly taskId: string
}

export interface PluginEvent {
  readonly id: string
}

/** Emitted when a plugin failed to unload and was quarantined. */
export interface PluginQuarantinedEvent {
  readonly id: string
  /** Manifest id for Bee Agent plugins; absent for plain cordis plugins. */
  readonly pluginId?: string | undefined
  readonly error: unknown
}

export interface KernelEvents {
  'state-changed': StateChangedEvent
  'service-registered': ServiceRegisteredEvent
  'service-unregistered': ServiceUnregisteredEvent
  'task-scope-created': TaskScopeEvent
  'task-scope-disposed': TaskScopeEvent
  'plugin-mounted': PluginEvent
  'plugin-unmounted': PluginEvent
  'plugin-quarantined': PluginQuarantinedEvent
}

export type KernelEventName = string & keyof KernelEvents

export type PluginHandleStatus = 'mounted' | 'disposed' | 'quarantined'

export interface PluginDrainOptions {
  /**
   * Upper bound for reaching quiescence. When the plugin does not finish
   * draining in time, the report says so instead of rejecting.
   */
  readonly timeoutMs?: number
}

export interface PluginDrainReport {
  /** True when the timeout elapsed before the plugin reached quiescence. */
  readonly timedOut: boolean
}

export type PluginHealthStatus = 'healthy' | 'degraded' | 'unhealthy'

export interface PluginHealthReport {
  readonly status: PluginHealthStatus
  readonly detail?: string
}

/** A quarantined plugin recorded by the kernel after a failed unload. */
export interface PluginQuarantineEntry {
  /** Kernel handle id of the failed plugin. */
  readonly id: string
  /** Manifest id for Bee Agent plugins; absent for plain cordis plugins. */
  readonly pluginId?: string | undefined
  /** The error that made the unload fail. */
  readonly error: unknown
}

export interface PluginHandle {
  readonly id: string
  readonly context: Context
  readonly disposed: boolean
  /** Lifecycle status; quarantined means the unload failed midway. */
  readonly status: PluginHandleStatus
  /** The error that quarantined this plugin, if any. */
  readonly quarantineError: unknown
  /** Declared hot-replacement tier (architecture §9.3). */
  readonly replacementTier: ReplacementTier
  /** Resolves when the mounted plugin finished starting; rejects on failure. */
  readonly ready: Promise<void>
  /**
   * Disposes the plugin. When the unload fails, the handle is quarantined,
   * the error is rethrown, and further dispose calls are no-ops — a
   * quarantined plugin requires a kernel restart and is never force-cleaned.
   */
  dispose(): Promise<void>
  update(config: unknown): void
  /**
   * Asks the plugin to stop accepting new work and wait for in-flight work
   * to reach quiescence. Plugins without a drain hook report immediately.
   */
  drain(options?: PluginDrainOptions): Promise<PluginDrainReport>
  /**
   * Probes the plugin's health. Plugins without a health-check hook report
   * healthy unless the handle is quarantined.
   */
  healthCheck(): Promise<PluginHealthReport>
}

export interface BeeAgentPluginMountOptions {
  /**
   * Services to publish on the kernel once the Bee Agent plugin started
   * successfully. Mapping values may be computed from the plugin instance.
   */
  services?:
    | Record<string, unknown>
    | ((plugin: BeeAgentPlugin) => Record<string, unknown>)
  /**
   * How safely this plugin can be hot-replaced (architecture §9.3):
   * `a` swaps only with no call in flight, `b` defers to the Turn boundary,
   * `c` refuses hot replacement and requires a restart. Defaults to `a`.
   */
  replacementTier?: ReplacementTier | undefined
}

/**
 * Optional lifecycle hooks the kernel recognizes on Bee Agent plugins:
 * drain/quiesce before hot operations, health checks for orchestration.
 * Required for Tier A/B hot replacement (ADR 0018).
 */
export interface BeeAgentPluginLifecycleHooks {
  /** Stop accepting new work and wait for in-flight work to finish. */
  drain(options?: PluginDrainOptions): Promise<PluginDrainReport>
  /** Liveness probe used before and after hot operations. */
  healthCheck(): Promise<PluginHealthReport>
}

/** A Bee Agent plugin that may implement the kernel lifecycle hooks. */
export type LifecycleBeeAgentPlugin = BeeAgentPlugin &
  Partial<BeeAgentPluginLifecycleHooks>

export interface BeeAgentPluginHandle extends PluginHandle {
  readonly plugin: LifecycleBeeAgentPlugin
}
