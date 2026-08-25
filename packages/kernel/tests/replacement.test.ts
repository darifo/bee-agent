import { describe, expect, it } from 'vitest'
import { ReplacementCoordinator } from '../src/index.ts'
import type { ReplacementRequest } from '../src/index.ts'

const STRUCTURE_A =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const STRUCTURE_B =
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function request(
  tier: 'a' | 'b' | 'c',
  key: string,
  log: string[],
  drain?: () => Promise<void>,
): ReplacementRequest<string> {
  return {
    tier,
    key,
    ...(drain !== undefined ? { drain } : {}),
    apply: async () => {
      log.push(`apply:${key}`)
      return key
    },
  }
}

describe('ReplacementCoordinator tier boundaries', () => {
  it('applies an A-tier replacement when no Turn is running', async () => {
    const coordinator = new ReplacementCoordinator()
    const log: string[] = []
    const outcome = await coordinator.replace(request('a', 'tool', log))
    expect(outcome).toEqual({ kind: 'applied', value: 'tool' })
    expect(log).toEqual(['apply:tool'])
    expect(coordinator.appliedKeys).toEqual(['tool'])
  })

  it('refuses an A-tier replacement while a Turn is executing', async () => {
    const coordinator = new ReplacementCoordinator()
    coordinator.beginTurn(STRUCTURE_A)
    await expect(coordinator.replace(request('a', 'tool', []))).rejects.toThrow(
      /A-tier replacement .* not allowed/,
    )
  })

  it('applies a B-tier replacement immediately when no Turn is running', async () => {
    const coordinator = new ReplacementCoordinator()
    const log: string[] = []
    const outcome = await coordinator.replace(
      request('b', 'model', log, async () => {
        log.push('drain:model')
      }),
    )
    expect(outcome).toEqual({ kind: 'applied', value: 'model' })
    expect(log).toEqual(['drain:model', 'apply:model'])
  })

  it('defers a B-tier replacement to the Turn boundary, draining then applying', async () => {
    const coordinator = new ReplacementCoordinator()
    const log: string[] = []
    coordinator.beginTurn(STRUCTURE_A)

    const outcome = await coordinator.replace(
      request('b', 'model', log, async () => {
        log.push('drain:model')
      }),
    )
    expect(outcome).toEqual({ kind: 'deferred' })
    expect(coordinator.pendingCount).toBe(1)
    expect(log).toEqual([]) // nothing applied during the Turn

    await coordinator.endTurn()
    expect(log).toEqual(['drain:model', 'apply:model'])
    expect(coordinator.pendingCount).toBe(0)
    expect(coordinator.appliedKeys).toEqual(['model'])
  })

  it('always reports restart-required for a C-tier replacement', async () => {
    const coordinator = new ReplacementCoordinator()
    const log: string[] = []
    const outcome = await coordinator.replace(request('c', 'store', log))
    expect(outcome).toEqual({ kind: 'restart-required' })
    expect(log).toEqual([])
    expect(coordinator.appliedKeys).toEqual([])
  })
})

describe('Turn pins the structure version', () => {
  it('keeps the pinned structure version across a deferred replacement', async () => {
    const coordinator = new ReplacementCoordinator()
    coordinator.beginTurn(STRUCTURE_A)

    const outcome = await coordinator.replace(request('b', 'model', []))
    expect(outcome).toEqual({ kind: 'deferred' })
    // The executing Turn still sees its original structure.
    expect(coordinator.structureVersion).toBe(STRUCTURE_A)

    await coordinator.endTurn()
    // Once the Turn ends, the pinned version is released.
    expect(coordinator.structureVersion).toBeUndefined()
  })

  it('rejects overlapping turns', () => {
    const coordinator = new ReplacementCoordinator()
    coordinator.beginTurn(STRUCTURE_A)
    expect(() => coordinator.beginTurn(STRUCTURE_B)).toThrow(
      /already executing/,
    )
  })

  it('applies deferred replacements in request order', async () => {
    const coordinator = new ReplacementCoordinator()
    const log: string[] = []
    coordinator.beginTurn(STRUCTURE_A)
    await coordinator.replace(request('b', 'model', log))
    await coordinator.replace(request('b', 'learner', log))
    await coordinator.endTurn()
    expect(log).toEqual(['apply:model', 'apply:learner'])
  })
})
