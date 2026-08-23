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

export function defineSerialEvent<P>(name: string): SerialEvent<P> {
  return { name } as SerialEvent<P>
}

export function defineWaterfallEvent<P, R>(name: string): WaterfallEvent<P, R> {
  return { name } as WaterfallEvent<P, R>
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
 * A framework-free domain event bus on the kernel. Serial events are awaited
 * listener-by-listener; waterfall events run middleware outermost-first around
 * a terminal implementation. Use {@link EventBus.createChild} for scope-bound
 * registrations that are removed together with the scope.
 */
export class EventBus {
  readonly #serial = new Map<string, Set<AnySerialListener>>()
  readonly #waterfall = new Map<string, AnyWaterfallMiddleware[]>()

  on<P>(key: string | SerialEvent<P>, listener: SerialListener<P>): () => void {
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

  on<P>(key: string | SerialEvent<P>, listener: SerialListener<P>): () => void {
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
