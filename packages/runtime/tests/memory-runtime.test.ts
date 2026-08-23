import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  EmbeddingRecord,
  VectorSearchQuery,
  VectorSearchResult,
} from '@bee-agent/contracts'
import { createKernel } from '@bee-agent/kernel'
import type { VectorStore } from '@bee-agent/vector-store'
import { MemoryRuntime, chunkContent } from '../src/index.js'
import { MemoryRuntimeError } from '../src/index.js'

/** Brute-force cosine store so runtime tests stay hermetic. */
class InMemoryVectorStore implements VectorStore {
  readonly #records: EmbeddingRecord[] = []

  async upsert(record: EmbeddingRecord): Promise<void> {
    const conflictIndex = this.#records.findIndex(
      (existing) =>
        existing.workspaceId === record.workspaceId &&
        existing.chunkId === record.chunkId &&
        existing.embeddingSpaceId === record.embeddingSpaceId,
    )
    if (conflictIndex >= 0) this.#records[conflictIndex] = record
    else this.#records.push(record)
  }

  async search(query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    const matches = this.#records
      .filter(
        (record) =>
          record.workspaceId === query.workspaceId &&
          record.embeddingSpaceId === query.embeddingSpace.id &&
          containsMetadata(record.metadata, query.metadata),
      )
      .map((record) => ({
        record,
        score: cosineDistance(query.vector, record.vector),
      }))
    matches.sort((a, b) => a.score - b.score)
    return matches.slice(0, query.limit)
  }

  async delete(id: string, workspaceId: string): Promise<void> {
    const index = this.#records.findIndex(
      (record) => record.id === id && record.workspaceId === workspaceId,
    )
    if (index >= 0) this.#records.splice(index, 1)
  }
}

function containsMetadata(
  record: Record<string, unknown>,
  filter: Record<string, unknown> | undefined,
): boolean {
  if (filter === undefined) return true
  for (const [key, expected] of Object.entries(filter)) {
    if (JSON.stringify(record[key]) !== JSON.stringify(expected)) return false
  }
  return true
}

function cosineDistance(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < a.length; index += 1) {
    dot += (a[index] ?? 0) * (b[index] ?? 0)
    normA += (a[index] ?? 0) ** 2
    normB += (b[index] ?? 0) ** 2
  }
  return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

function createMemory(store: VectorStore = new InMemoryVectorStore()) {
  const kernel = createKernel()
  return {
    kernel,
    store,
    memory: new MemoryRuntime(kernel, { vectorStore: store }),
  }
}

describe('chunkContent', () => {
  it('splits on word boundaries within the size budget', () => {
    expect(chunkContent('aaa bbb ccc ddd', 7)).toEqual(['aaa bbb', 'ccc ddd'])
    expect(chunkContent('short', 100)).toEqual(['short'])
  })

  it('keeps oversized single words intact', () => {
    expect(chunkContent('abcdefghij xx', 4)).toEqual(['abcdefghij', 'xx'])
  })

  it('drops pure whitespace', () => {
    expect(chunkContent('   \t  ', 10)).toEqual([])
  })
})

describe('MemoryRuntime', () => {
  it('remembers and recalls by semantic proximity', async () => {
    const { memory } = createMemory()
    const workspaceId = randomUUID()
    await memory.remember({
      workspaceId,
      content: 'the cat sat on the mat',
    })
    await memory.remember({
      workspaceId,
      content: 'quarterly financial results exceeded expectations',
    })

    const results = await memory.recall({
      workspaceId,
      text: 'cat mat',
    })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]?.chunk.content).toContain('cat sat')
    expect(results[0]?.score).toBeLessThanOrEqual(results.at(-1)?.score ?? 1)
  })

  it('chunks long documents with stable ordinals', async () => {
    const memory = new MemoryRuntime(createKernel(), {
      vectorStore: new InMemoryVectorStore(),
      chunkSize: 24,
    })
    const workspaceId = randomUUID()
    const words = Array.from({ length: 30 }, (_, i) => `word${i}`)
    const remembered = await memory.remember({
      workspaceId,
      content: words.join(' '),
    })

    expect(remembered.chunks.length).toBeGreaterThan(1)
    expect(remembered.chunks.map((chunk) => chunk.ordinal)).toEqual(
      remembered.chunks.map((_, index) => index),
    )
    expect(remembered.chunks.map((chunk) => chunk.content).join(' ')).toBe(
      words.join(' '),
    )
    expect(
      new Set(remembered.chunks.map((chunk) => chunk.documentId)).size,
    ).toBe(1)
  })

  it('rejects documents without any words', async () => {
    const { memory } = createMemory()
    await expect(
      memory.remember({ workspaceId: randomUUID(), content: '   ' }),
    ).rejects.toThrow(MemoryRuntimeError)
  })

  it('isolates workspaces in recall', async () => {
    const { memory } = createMemory()
    const own = randomUUID()
    await memory.remember({ workspaceId: own, content: 'cat cat cat' })

    expect(
      await memory.recall({ workspaceId: randomUUID(), text: 'cat' }),
    ).toEqual([])
    expect(await memory.recall({ workspaceId: own, text: 'cat' })).toHaveLength(
      1,
    )
  })

  it('narrows recall by document metadata', async () => {
    const { memory } = createMemory()
    const workspaceId = randomUUID()
    await memory.remember({
      workspaceId,
      content: 'cat cat cat',
      metadata: { kind: 'pet' },
    })
    await memory.remember({
      workspaceId,
      content: 'cat cat cat',
      metadata: { kind: 'finance' },
    })

    const results = await memory.recall({
      workspaceId,
      text: 'cat',
      metadata: { kind: 'finance' },
    })
    expect(results).toHaveLength(1)
  })

  it('forgets chunks so they disappear from recall', async () => {
    const { memory } = createMemory()
    const workspaceId = randomUUID()
    const { chunks } = await memory.remember({
      workspaceId,
      content: 'cat cat cat',
    })
    expect(await memory.recall({ workspaceId, text: 'cat' })).toHaveLength(1)

    await memory.forget(chunks[0]!.id, workspaceId)
    expect(await memory.recall({ workspaceId, text: 'cat' })).toEqual([])
  })

  it('caps recall at the requested limit', async () => {
    const memory = new MemoryRuntime(createKernel(), {
      vectorStore: new InMemoryVectorStore(),
      chunkSize: 12,
    })
    const workspaceId = randomUUID()
    await memory.remember({
      workspaceId,
      content: Array.from({ length: 30 }, (_, i) => `alpha${i} beta`).join(' '),
    })

    const all = await memory.recall({ workspaceId, text: 'alpha beta' })
    expect(all).toHaveLength(10)
    const top3 = await memory.recall({
      workspaceId,
      text: 'alpha beta',
      limit: 3,
    })
    expect(top3).toHaveLength(3)
  })

  it('keeps embedder spaces separate per embedder', async () => {
    const store = new InMemoryVectorStore()
    const workspaceId = randomUUID()
    const first = new MemoryRuntime(createKernel(), { vectorStore: store })
    await first.remember({ workspaceId, content: 'cat cat cat' })
    expect(await first.recall({ workspaceId, text: 'cat' })).toHaveLength(1)

    // Same store, different embedder → different embedding space → no hits.
    const second = new MemoryRuntime(createKernel(), {
      vectorStore: store,
      embedder: {
        space: {
          id: 'other-embedder',
          model: 'other-embedder',
          dimensions: 4,
          metric: 'cosine',
        },
        embed: async (inputs) => inputs.map(() => [1, 0, 0, 0]),
      },
    })
    expect(await second.recall({ workspaceId, text: 'cat' })).toEqual([])
  })
})
