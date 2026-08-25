import { describe, expect, it } from 'vitest'
import { Context, FiberState } from '../src/index.ts'

/**
 * Smoke test for the vendored cordis runtime (src/cordis), proving the port
 * is consumable from Bee's own package: Proxy service access, inject-driven
 * activation, and LIFO async effect disposal all work end to end.
 */
describe('ported cordis runtime', () => {
  it('provides and resolves a service through the proxy Context', () => {
    const ctx = new Context()
    const llm = { generate: () => 'hi' }
    ctx.provide('llm', llm)
    expect(ctx.get('llm')).toBe(llm)
  })

  it('activates a plugin only after its injected dependencies exist', async () => {
    const ctx = new Context()
    const started: string[] = []
    const fiber = ctx.plugin(
      Object.assign(
        function plugin() {
          started.push('ran')
        },
        { inject: ['llm'] },
      ),
    )
    // Dependency `llm` is still missing, so the plugin must not have run.
    expect(started).toEqual([])
    const off = ctx.provide('llm', {})
    await fiber
    expect(started).toEqual(['ran'])
    await off()
  })

  it('releases effects in LIFO order on dispose', async () => {
    const ctx = new Context()
    const order: string[] = []
    const fiber = ctx.plugin(function plugin(ctx: Context) {
      ctx.effect(
        () => () => {
          order.push('first')
        },
        'first',
      )
      ctx.effect(
        () => () => {
          order.push('second')
        },
        'second',
      )
    })
    await fiber
    await fiber.dispose()
    expect(order).toEqual(['second', 'first'])
  })

  it('unloads and remounts a Fiber when an injected service changes', async () => {
    const ctx = new Context()
    let starts = 0
    let stops = 0
    const plugin = Object.assign(
      function reactive(ctx: Context) {
        void (ctx as Context & { llm: object }).llm
        starts += 1
        ctx.effect(() => () => {
          stops += 1
        })
      },
      { inject: ['llm'] },
    )
    const fiber = ctx.plugin(plugin)
    const removeFirst = ctx.provide('llm', { version: 1 })
    await fiber
    expect(starts).toBe(1)

    await removeFirst()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fiber.state).toBe(FiberState.PENDING)
    expect(stops).toBe(1)

    const removeSecond = ctx.provide('llm', { version: 2 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fiber.state).toBe(FiberState.ACTIVE)
    expect(starts).toBe(2)

    await fiber.dispose()
    await removeSecond()
    expect(stops).toBe(2)
  })
})
