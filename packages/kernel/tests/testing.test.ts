import { describe, expect, it } from 'vitest'

import {
  FakeClock,
  createFakeTool,
  createScriptedModel,
} from '../src/testing.js'

describe('FakeClock', () => {
  it('starts at the injected epoch and never reads wall-clock time', () => {
    const clock = new FakeClock(1000)
    expect(clock.epochMs()).toBe(1000)
    expect(clock.now().toISOString()).toBe('1970-01-01T00:00:01.000Z')
  })

  it('fires due timers in time then scheduling order', () => {
    const clock = new FakeClock()
    const fired: string[] = []
    clock.schedule(30, () => fired.push('late'))
    clock.schedule(10, () => fired.push('early'))
    clock.schedule(10, () => fired.push('early-2'))
    expect(fired).toEqual([])
    clock.advance(10)
    expect(fired).toEqual(['early', 'early-2'])
    expect(clock.epochMs()).toBe(10)
    clock.advance(20)
    expect(fired).toEqual(['early', 'early-2', 'late'])
  })

  it('fires timers scheduled while advancing once they come due', () => {
    const clock = new FakeClock()
    const fired: string[] = []
    clock.schedule(5, () => {
      fired.push('first')
      clock.schedule(5, () => fired.push('chained'))
    })
    clock.advance(10)
    expect(fired).toEqual(['first', 'chained'])
  })

  it('ignores canceled timers and reports pending counts', () => {
    const clock = new FakeClock()
    const cancel = clock.schedule(10, () => {
      throw new Error('must not run')
    })
    clock.schedule(20, () => undefined)
    expect(clock.pendingTimerCount()).toBe(2)
    cancel()
    expect(clock.pendingTimerCount()).toBe(1)
    clock.advance(30)
    expect(clock.pendingTimerCount()).toBe(0)
  })

  it('rejects backwards advancement', () => {
    const clock = new FakeClock()
    expect(() => clock.advance(-1)).toThrow(RangeError)
  })
})

describe('createFakeTool', () => {
  it('records calls and echoes input by default', async () => {
    const tool = createFakeTool({ id: 'tools.echo' })
    const result = await tool.execute({ value: 1 }, { callId: 'c1' })
    expect(result).toEqual({ value: 1 })
    expect(tool.calls).toEqual([
      { input: { value: 1 }, context: { callId: 'c1' } },
    ])
    expect(tool.manifest.id).toBe('tools.echo')
    expect(tool.manifest.inputSchema).toEqual({ type: 'object' })
  })

  it('delegates to the injected handler', async () => {
    const tool = createFakeTool({
      handler: (input) => `saw ${(input as { n: number }).n}`,
    })
    await expect(tool.execute({ n: 7 }, undefined)).resolves.toBe('saw 7')
    expect(tool.calls).toHaveLength(1)
  })
})

describe('createScriptedModel', () => {
  it('issues scripted decisions in order and records them', async () => {
    const model = createScriptedModel([
      { kind: 'tool-call', toolId: 'tools.echo', input: { q: 1 } },
      { kind: 'text', content: 'done' },
    ])
    await expect(model.respond({})).resolves.toEqual({
      kind: 'tool-call',
      toolId: 'tools.echo',
      input: { q: 1 },
    })
    await expect(model.respond({})).resolves.toEqual({
      kind: 'text',
      content: 'done',
    })
    expect(model.issued).toHaveLength(2)
  })

  it('throws the scripted error and rejects when the script runs dry', async () => {
    const model = createScriptedModel([
      { kind: 'error', error: new Error('boom') },
    ])
    await expect(model.respond({})).rejects.toThrow('boom')
    await expect(model.respond({})).rejects.toThrow('ran out of steps')
  })
})
