import type { EmbeddingSpace } from '@bee-agent/contracts'

/**
 * Turns text into vectors in a single, self-described embedding space.
 * Implementations must be deterministic: the same input always yields the
 * same vector, or stored records and queries drift apart.
 */
export interface Embedder {
  /** The space every vector produced by this embedder belongs to. */
  readonly space: EmbeddingSpace
  embed(inputs: readonly string[]): Promise<readonly number[][]>
}

export interface MockEmbedderOptions {
  /** Defaults to `mock.hash-embedder`. */
  readonly model?: string | undefined
  /** Vector size; defaults to 64. */
  readonly dimensions?: number | undefined
  /** Defaults to `cosine`. */
  readonly metric?: EmbeddingSpace['metric'] | undefined
}

const TOKEN_SEPARATOR = /[^\p{L}\p{N}]+/u

function fnv1a(token: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

/**
 * Deterministic bag-of-tokens embedder: every token is hashed (FNV-1a) into
 * one dimension and the vector is L2-normalized, so cosine similarity
 * tracks token overlap. It stands in for real model providers until those
 * arrive, keeping tests hermetic and local mode dependency-free.
 */
export class MockEmbedder implements Embedder {
  readonly space: EmbeddingSpace
  readonly #dimensions: number

  constructor(options: MockEmbedderOptions = {}) {
    this.#dimensions = options.dimensions ?? 64
    this.space = {
      id: options.model ?? 'mock.hash-embedder',
      model: options.model ?? 'mock.hash-embedder',
      dimensions: this.#dimensions,
      metric: options.metric ?? 'cosine',
    }
  }

  async embed(inputs: readonly string[]): Promise<readonly number[][]> {
    return inputs.map((input) => [...this.embedOne(input)])
  }

  embedOne(input: string): number[] {
    const vector = new Array<number>(this.#dimensions).fill(0)
    const tokens = input.toLowerCase().split(TOKEN_SEPARATOR)
    let counted = 0
    for (const token of tokens) {
      if (token.length === 0) continue
      const index = fnv1a(token) % this.#dimensions
      vector[index] = (vector[index] ?? 0) + 1
      counted += 1
    }
    if (counted === 0) {
      // No tokens at all: fall back to the first basis vector so pgvector
      // never sees a zero norm (cosine of 0 is undefined).
      vector[0] = 1
      return vector
    }
    let sum = 0
    for (const value of vector) sum += value * value
    const norm = Math.sqrt(sum)
    return vector.map((value) => value / norm)
  }
}
