import { describe, expect, it, vi } from 'vitest'

import {
  EventBus,
  defineBroadcastEvent,
  defineParallelEvent,
  defineSerialEvent,
} from '../src/events.js'

describe('EventBus emit (broadcast)', () => {
  const pinged = defineBroadcastEvent<{ n: number }>('test/pinged')

  it('runs every listener even when earlier listeners fail', async () => {
    const bus = new EventBus()
    const calls: string[] = []
    bus.on(pinged, () => {
      calls.push('first')
      throw new Error('first fails')
    })
    bus.on(pinged, () => {
      calls.push('second')
    })

    await expect(bus.emit(pinged, { n: 1 })).resolves.toBeUndefined()
    expect(calls).toEqual(['first', 'second'])
  })

  it('reports each isolated failure to onError and never rejects', async () => {
    const bus = new EventBus()
    const boom = new Error('boom')
    const bang = new Error('bang')
    const errors: unknown[] = []
    bus.on(pinged, () => {
      throw boom
    })
    bus.on(pinged, async () => {
      throw bang
    })
    bus.on(pinged, () => undefined)

    await bus.emit(pinged, { n: 1 }, { onError: (error) => errors.push(error) })
    expect(errors).toEqual([boom, bang])
  })

  it('settles only after async listeners finish', async () => {
    const bus = new EventBus()
    let done = false
    bus.on(pinged, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      done = true
    })
    await bus.emit(pinged, { n: 1 })
    expect(done).toBe(true)
  })

  it('tolerates events with no listeners', async () => {
    const bus = new EventBus()
    await expect(bus.emit(pinged, { n: 1 })).resolves.toBeUndefined()
  })
})

describe('EventBus parallel', () => {
  const kicked = defineParallelEvent<{ n: number }>('test/kicked')

  it('runs listeners concurrently and succeeds when all pass', async () => {
    const bus = new EventBus()
    let running = 0
    let peak = 0
    bus.on(kicked, async () => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 5))
      running -= 1
    })
    bus.on(kicked, async () => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 5))
      running -= 1
    })

    await bus.parallel(kicked, { n: 1 })
    expect(peak).toBe(2)
  })

  it('rejects with an AggregateError holding every failure in order', async () => {
    const bus = new EventBus()
    const boom = new Error('boom')
    const bang = new Error('bang')
    const survivor = vi.fn()
    bus.on(kicked, () => {
      throw boom
    })
    bus.on(kicked, async () => {
      throw bang
    })
    bus.on(kicked, survivor)

    const failure = await bus.parallel(kicked, { n: 1 }).catch((error) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([boom, bang])
    expect(survivor).toHaveBeenCalledWith({ n: 1 })
  })

  it('tolerates events with no listeners', async () => {
    const bus = new EventBus()
    await expect(bus.parallel(kicked, { n: 1 })).resolves.toBeUndefined()
  })
})

describe('event mode independence', () => {
  it('serial dispatch still aborts the chain semantics and shares listeners', async () => {
    const bus = new EventBus()
    const both = defineSerialEvent<string>('test/shared')
    const order: string[] = []
    bus.on(both, async (payload) => {
      order.push(`a:${payload}`)
    })
    bus.on(both, async (payload) => {
      order.push(`b:${payload}`)
    })

    await bus.dispatch(both, 'x')
    expect(order).toEqual(['a:x', 'b:x'])
    order.length = 0
    await bus.emit('test/shared', 'y')
    expect(order).toEqual(['a:y', 'b:y'])
  })
})
