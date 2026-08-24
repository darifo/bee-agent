/**
 * Typed domain event keys, mirroring {@link defineServiceKey}: a key carries
 * the payload (and result) type so listeners and middleware are inferred
 * instead of relying on bare strings.
 */
export interface SerialEvent<P> {
  readonly __serialPayload: P
  readonly name: string
}

export interface WaterfallEvent<P, R> {
  readonly __waterfallPayload: P
  readonly __waterfallResult: R
  readonly name: string
}

/** Broadcast key: `emit` runs every listener isolated from failures. */
export interface BroadcastEvent<P> {
  readonly __broadcastPayload: P
  readonly name: string
}

/** Parallel key: `parallel` awaits all listeners and aggregates failures. */
export interface ParallelEvent<P> {
  readonly __parallelPayload: P
  readonly name: string
}

export function defineSerialEvent<P>(name: string): SerialEvent<P> {
  return { name } as SerialEvent<P>
}

export function defineWaterfallEvent<P, R>(name: string): WaterfallEvent<P, R> {
  return { name } as WaterfallEvent<P, R>
}

export function defineBroadcastEvent<P>(name: string): BroadcastEvent<P> {
  return { name } as BroadcastEvent<P>
}

export function defineParallelEvent<P>(name: string): ParallelEvent<P> {
  return { name } as ParallelEvent<P>
}

export type SerialListener<P> = (payload: P) => void | Promise<void>

/**
 * Waterfall middleware must call `next` to continue the chain, forming an
 * interception pipeline around the terminal implementation. Middleware that
 * returns without calling `next` short-circuits the pipeline.
 */
export type WaterfallMiddleware<P, R> = (
  payload: P,
  next: (payload: P) => Promise<R>,
) => Promise<R>

export type WaterfallTerminal<P, R> = (payload: P) => Promise<R>

type AnySerialListener = (payload: unknown) => unknown
type AnyWaterfallMiddleware = (
  payload: unknown,
  next: (payload: unknown) => Promise<unknown>,
) => Promise<unknown>

type EventKeyLike = string | { readonly name: string }

function eventKeyName(key: EventKeyLike): string {
  return typeof key === 'string' ? key : key.name
}

/**
 * A framework-free domain event bus on the kernel. One registry of listeners
 * per event name, four execution semantics at the call site: `dispatch` runs
 * listeners serially in registration order, `emit` broadcasts with every
 * listener isolated from the others' failures, `parallel` awaits all
 * listeners concurrently and aggregates failures, and `waterfall` folds
 * middleware around a terminal implementation. Use {@link EventBus.createChild}
 * for scope-bound registrations that are removed together with the scope.
 */
export class EventBus {
  readonly #serial = new Map<string, Set<AnySerialListener>>()
  readonly #waterfall = new Map<string, AnyWaterfallMiddleware[]>()

  on<P>(
    key: string | SerialEvent<P> | BroadcastEvent<P> | ParallelEvent<P>,
    listener: SerialListener<P>,
  ): () => void {
    const name = eventKeyName(key)
    let listeners = this.#serial.get(name)
    if (!listeners) {
      listeners = new Set()
      this.#serial.set(name, listeners)
    }
    const bound = listener as AnySerialListener
    listeners.add(bound)
    return () => {
      listeners.delete(bound)
    }
  }

  /** Dispatches a serial event; listeners run in registration order. */
  async dispatch<P>(key: string | SerialEvent<P>, payload: P): Promise<void> {
    const listeners = this.#serial.get(eventKeyName(key))
    if (!listeners) return
    let error: unknown
    let failed = false
    for (const listener of [...listeners]) {
      try {
        await listener(payload)
      } catch (reason) {
        if (!failed) {
          failed = true
          error = reason
        }
      }
    }
    if (failed) throw error
  }

  /**
   * Broadcasts an event: every listener runs, a failing listener never
   * prevents the others from running, and the returned promise settles only
   * once all listeners have settled. Failures are passed to `onError` (one
   * call per failed listener, in registration order) and are otherwise
   * swallowed — `emit` itself never rejects.
   */
  async emit<P>(
    key: string | BroadcastEvent<P>,
    payload: P,
    options: { onError?: (error: unknown) => void } = {},
  ): Promise<void> {
    const listeners = this.#serial.get(eventKeyName(key))
    if (!listeners) return
    const settled = await Promise.allSettled(
      [...listeners].map((listener) =>
        Promise.resolve().then(() => listener(payload)),
      ),
    )
    for (const result of settled) {
      if (result.status === 'rejected') options.onError?.(result.reason)
    }
  }

  /**
   * Dispatches a parallel event: all listeners start concurrently and are
   * awaited together; any failure rejects with an `AggregateError` holding
   * every failure in registration order.
   */
  async parallel<P>(key: string | ParallelEvent<P>, payload: P): Promise<void> {
    const listeners = this.#serial.get(eventKeyName(key))
    if (!listeners) return
    const settled = await Promise.allSettled(
      [...listeners].map((listener) =>
        Promise.resolve().then(() => listener(payload)),
      ),
    )
    const errors = settled
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      )
      .map((result) => result.reason)
    if (errors.length > 0) throw new AggregateError(errors)
  }

  use<P, R>(
    key: string | WaterfallEvent<P, R>,
    middleware: WaterfallMiddleware<P, R>,
  ): () => void {
    const name = eventKeyName(key)
    let middlewares = this.#waterfall.get(name)
    if (!middlewares) {
      middlewares = []
      this.#waterfall.set(name, middlewares)
    }
    const bound = middleware as AnyWaterfallMiddleware
    middlewares.push(bound)
    return () => {
      const list = this.#waterfall.get(name)
      if (!list) return
      const index = list.indexOf(bound)
      if (index >= 0) list.splice(index, 1)
    }
  }

  /**
   * Runs a waterfall event: middleware registered first is outermost; the
   * terminal implementation runs when every middleware called `next`.
   */
  async waterfall<P, R>(
    key: string | WaterfallEvent<P, R>,
    payload: P,
    terminal: WaterfallTerminal<P, R>,
  ): Promise<R> {
    const middlewares = this.#waterfall.get(eventKeyName(key)) ?? []
    let handler: WaterfallTerminal<P, R> = terminal
    for (let i = middlewares.length - 1; i >= 0; i--) {
      const middleware = middlewares[i] as unknown as WaterfallMiddleware<P, R>
      const next = handler
      handler = (current) => middleware(current, next)
    }
    return handler(payload)
  }

  createChild(): EventBusChild {
    return new EventBusChild(this)
  }
}

/**
 * A scope-bound view over a parent {@link EventBus}. Registrations delegate to
 * the parent and are removed when {@link dispose} runs; dispatching and
 * waterfall evaluation always use the parent's listener sets.
 */
export class EventBusChild {
  readonly #parent: EventBus
  #disposers: Array<() => void> = []

  constructor(parent: EventBus) {
    this.#parent = parent
  }

  on<P>(
    key: string | SerialEvent<P> | BroadcastEvent<P> | ParallelEvent<P>,
    listener: SerialListener<P>,
  ): () => void {
    const off = this.#parent.on(key, listener)
    this.#disposers.push(off)
    return off
  }

  use<P, R>(
    key: string | WaterfallEvent<P, R>,
    middleware: WaterfallMiddleware<P, R>,
  ): () => void {
    const off = this.#parent.use(key, middleware)
    this.#disposers.push(off)
    return off
  }

  dispatch<P>(key: string | SerialEvent<P>, payload: P): Promise<void> {
    return this.#parent.dispatch(key, payload)
  }

  emit<P>(
    key: string | BroadcastEvent<P>,
    payload: P,
    options?: { onError?: (error: unknown) => void },
  ): Promise<void> {
    return this.#parent.emit(key, payload, options)
  }

  parallel<P>(key: string | ParallelEvent<P>, payload: P): Promise<void> {
    return this.#parent.parallel(key, payload)
  }

  waterfall<P, R>(
    key: string | WaterfallEvent<P, R>,
    payload: P,
    terminal: WaterfallTerminal<P, R>,
  ): Promise<R> {
    return this.#parent.waterfall(key, payload, terminal)
  }

  /** Removes every registration made through this child bus. */
  dispose(): void {
    for (const dispose of this.#disposers.splice(0)) {
      dispose()
    }
  }
}
