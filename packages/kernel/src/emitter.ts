import type { KernelEventName, KernelEvents } from './types.js'

type AnyListener = (payload: unknown) => void

/**
 * Minimal synchronous emitter behind {@link Kernel.on}. Every listener runs on
 * emit; the first listener error is rethrown after the remaining listeners
 * finished so one bad listener cannot skip the others.
 */
export class KernelEmitter {
  readonly #listeners = new Map<KernelEventName, Set<AnyListener>>()

  on<K extends KernelEventName>(
    event: K,
    listener: (payload: KernelEvents[K]) => void,
  ): () => void {
    let listeners = this.#listeners.get(event)
    if (!listeners) {
      listeners = new Set()
      this.#listeners.set(event, listeners)
    }
    const bound = listener as AnyListener
    listeners.add(bound)
    return () => {
      listeners.delete(bound)
    }
  }

  emit<K extends KernelEventName>(event: K, payload: KernelEvents[K]): void {
    const listeners = this.#listeners.get(event)
    if (!listeners) return
    let error: unknown
    let failed = false
    for (const listener of [...listeners]) {
      try {
        listener(payload)
      } catch (reason) {
        if (!failed) {
          failed = true
          error = reason
        }
      }
    }
    if (failed) throw error
  }
}
