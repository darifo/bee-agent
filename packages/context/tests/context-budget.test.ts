import { describe, expect, it } from 'vitest'
import {
  allocateContextBudget,
  compileContextManifest,
  truncatingCompression,
} from '../src/context-budget.ts'
import type { PromptSection } from '../src/context-budget.ts'

function section(
  init: Partial<PromptSection> & Pick<PromptSection, 'id'>,
): PromptSection {
  return { kind: 'memory', priority: 5, content: '', ...init }
}

describe('allocateContextBudget', () => {
  it('orders by priority and drops the lowest first', () => {
    const low = section({ id: 'low', priority: 8, content: 'x'.repeat(40) })
    const high = section({
      id: 'high',
      kind: 'goal',
      priority: 2,
      content: 'y'.repeat(40),
    })
    const mid = section({
      id: 'mid',
      kind: 'world',
      priority: 3,
      content: 'z'.repeat(40),
    })

    const allocation = allocateContextBudget([low, high, mid], 20)
    expect(allocation.sections.map((s) => s.id)).toEqual(['high', 'mid'])
    expect(allocation.omissions.map((o) => o.sourceId)).toEqual(['low'])
    expect(allocation.usedTokens).toBe(20)
    expect(allocation.totalTokens).toBe(30)
  })

  it('keeps protected content even when it exceeds the budget', () => {
    const approval = section({
      id: 'approval',
      kind: 'instruction',
      priority: 1,
      content: 'A'.repeat(100), // 25 tokens
      protectedBy: ['pending-approval'],
    })
    const big = section({ id: 'big', priority: 8, content: 'B'.repeat(200) }) // 50 tokens

    const allocation = allocateContextBudget([big, approval], 10)
    expect(allocation.sections.map((s) => s.id)).toEqual(['approval'])
    expect(allocation.omissions).toEqual([
      { sourceId: 'big', reason: 'budget-exceeded' },
    ])
    expect(allocation.usedTokens).toBe(25)
    expect(allocation.totalTokens).toBe(75)
  })
})

describe('truncatingCompression', () => {
  it('keeps the head and elides the tail within the budget', () => {
    const content = '0123456789'.repeat(10)
    const compressed = truncatingCompression.compress(content, 10)
    expect(compressed.length).toBeLessThanOrEqual(40)
    expect(compressed.startsWith('0123456789')).toBe(true)
    expect(compressed.endsWith('…')).toBe(true)
    expect(truncatingCompression.compress('short', 10)).toBe('short')
  })
})

describe('compileContextManifest', () => {
  it('builds a manifest whose sections and omissions explain the token spend', () => {
    const safety = section({
      id: 'safety',
      kind: 'instruction',
      priority: 1,
      content: 'S'.repeat(100), // 25 tokens
      protectedBy: ['permission-boundary'],
    })
    const history = section({
      id: 'history',
      priority: 8,
      content: 'H'.repeat(200), // 50 tokens
    })

    const manifest = compileContextManifest({
      id: '00000000-0000-4000-8000-000000000000',
      promptVersion: 'v1',
      structureVersion: 'structure-v1',
      tokenBudget: 10,
      sections: [history, safety],
    })

    expect(manifest.sections.map((s) => s.kind)).toEqual(['instruction'])
    expect(manifest.omissions).toEqual([
      { sourceId: 'history', reason: 'budget-exceeded' },
    ])
    const used = manifest.sections.reduce((sum, s) => sum + s.tokens, 0)
    expect(used).toBe(25)
  })
})
