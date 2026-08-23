import type { Context } from 'cordis'
import type { EventBusChild } from './events.js'
import type { BeeAgentPlugin } from '@bee-agent/plugin-sdk'

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
  dispose(): void
  /**
   * Registers a cleanup callback that runs when the scope is disposed, either
   * through {@link TaskScope.dispose}, {@link Kernel.disposeTaskScope}, or
   * kernel shutdown. Callbacks run in registration order. Returns a function
   * that unregisters the callback.
   */
  onDispose(callback: () => void | Promise<void>): () => void
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

export interface KernelEvents {
  'state-changed': StateChangedEvent
  'service-registered': ServiceRegisteredEvent
  'service-unregistered': ServiceUnregisteredEvent
  'task-scope-created': TaskScopeEvent
  'task-scope-disposed': TaskScopeEvent
  'plugin-mounted': PluginEvent
  'plugin-unmounted': PluginEvent
}

export type KernelEventName = string & keyof KernelEvents

export interface PluginHandle {
  readonly id: string
  readonly context: Context
  readonly disposed: boolean
  /** Resolves when the mounted plugin finished starting; rejects on failure. */
  readonly ready: Promise<void>
  dispose(): Promise<void>
  update(config: unknown): void
}

export interface BeeAgentPluginMountOptions {
  /**
   * Services to publish on the kernel once the Bee Agent plugin started
   * successfully. Mapping values may be computed from the plugin instance.
   */
  services?:
    | Record<string, unknown>
    | ((plugin: BeeAgentPlugin) => Record<string, unknown>)
}

export interface BeeAgentPluginHandle extends PluginHandle {
  readonly plugin: BeeAgentPlugin
}
