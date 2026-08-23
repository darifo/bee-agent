import { describe, expect, it } from 'vitest'
import { createKernel } from '../src/index.js'

describe('Kernel', () => {
  it('registers services and releases task-scoped effects', async () => {
    const kernel = createKernel()
    await kernel.start()

    const service = { answer: 42 }
    const unregister = kernel.registerService('answerService', service)
    expect(kernel.context.get('answerService')).toBe(service)

    const scope = kernel.createTaskScope('task-1')
    let released = false
    scope.context.effect(() => () => {
      released = true
    })
    scope.dispose()

    expect(scope.disposed).toBe(true)
    expect(released).toBe(true)
    unregister()
    expect(kernel.context.get('answerService')).toBeUndefined()
    await kernel.stop()
  })

  it('requires the root context to be started before opening a task scope', () => {
    const kernel = createKernel()
    expect(() => kernel.createTaskScope('task-1')).toThrow(/started/)
  })
})
