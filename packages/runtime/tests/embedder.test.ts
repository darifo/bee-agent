import { describe, expect, it } from 'vitest'
import { MockEmbedder } from '../src/index.js'

describe('MockEmbedder', () => {
  it('is deterministic for identical input', () => {
    const embedder = new MockEmbedder()
    expect(embedder.embedOne('Hello, world!')).toEqual(
      embedder.embedOne('Hello, world!'),
    )
  })

  it('ignores case and punctuation', () => {
    const embedder = new MockEmbedder()
    expect(embedder.embedOne('Hello')).toEqual(embedder.embedOne('hello!'))
  })

  it('produces vectors of the configured size with unit norm', () => {
    const embedder = new MockEmbedder({ dimensions: 8 })
    const vector = embedder.embedOne('the cat sat on the mat')
    expect(vector).toHaveLength(8)
    const sum = vector.reduce((total, value) => total + value * value, 0)
    expect(sum).toBeCloseTo(1, 10)
  })

  it('scores token overlap as similarity', () => {
    const embedder = new MockEmbedder()
    const dot = (a: readonly number[], b: readonly number[]) =>
      a.reduce((total, value, index) => total + value * (b[index] ?? 0), 0)

    const same = dot(embedder.embedOne('cat sat'), embedder.embedOne('sat cat'))
    expect(same).toBeCloseTo(1, 10)

    const overlap = dot(
      embedder.embedOne('cat sat'),
      embedder.embedOne('dog sat'),
    )
    expect(overlap).toBeGreaterThan(0)
    expect(overlap).toBeLessThan(1)
  })

  it('falls back to a basis vector for tokenless input', () => {
    const embedder = new MockEmbedder({ dimensions: 4 })
    expect([...embedder.embedOne('!!! ...')]).toEqual([1, 0, 0, 0])
  })

  it('describes its embedding space', () => {
    const embedder = new MockEmbedder({ model: 'test.model', dimensions: 16 })
    expect(embedder.space).toEqual({
      id: 'test.model',
      model: 'test.model',
      dimensions: 16,
      metric: 'cosine',
    })
  })
})
