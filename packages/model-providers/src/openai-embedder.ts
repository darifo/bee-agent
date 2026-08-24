import type { EmbeddingSpace } from '@bee-agent/contracts'
import type { Embedder } from '@bee-agent/runtime'
import { ModelProtocolError } from './errors.js'
import type { HttpOptions } from './shared.js'
import {
  DEFAULT_OPENAI_BASE_URL,
  joinUrl,
  postJson,
  requireRecord,
} from './shared.js'

export interface OpenAIEmbedderOptions extends HttpOptions {
  /**
   * OpenAI-compatible API base; `/embeddings` is appended. Defaults to
   * `https://api.openai.com/v1`.
   */
  readonly baseUrl?: string | undefined
  readonly apiKey: string
  readonly model: string
  /** Declared dimensions of the embedding space; responses must match. */
  readonly dimensions: number
  /** Defaults to `cosine`. */
  readonly metric?: EmbeddingSpace['metric'] | undefined
  /** Embedding-space id; defaults to the model name. */
  readonly spaceId?: string | undefined
}

/**
 * Embedder over the OpenAI-compatible `/embeddings` surface. The space is
 * declared up front (model, dimensions, metric) so the Vector Store's
 * embedding-space validation can police provider drift.
 */
export class OpenAIEmbedder implements Embedder {
  readonly space: EmbeddingSpace
  readonly #baseUrl: string
  readonly #apiKey: string
  readonly #model: string
  readonly #http: HttpOptions

  constructor(options: OpenAIEmbedderOptions) {
    this.space = {
      id: options.spaceId ?? options.model,
      model: options.model,
      dimensions: options.dimensions,
      metric: options.metric ?? 'cosine',
    }
    this.#baseUrl = options.baseUrl ?? DEFAULT_OPENAI_BASE_URL
    this.#apiKey = options.apiKey
    this.#model = options.model
    this.#http = { fetch: options.fetch, timeoutMs: options.timeoutMs }
  }

  async embed(inputs: readonly string[]): Promise<readonly number[][]> {
    if (inputs.length === 0) return []
    const payload = await postJson(
      joinUrl(this.#baseUrl, '/embeddings'),
      this.#apiKey,
      { model: this.#model, input: inputs },
      this.#http,
    )
    const body = requireRecord(payload, 'data')
    const data = body.data
    if (!Array.isArray(data) || data.length !== inputs.length) {
      throw new ModelProtocolError(
        `Expected ${inputs.length} embeddings, got ${
          Array.isArray(data) ? data.length : 'none'
        }`,
        payload,
      )
    }

    // Providers may return embeddings out of order; the index field is the
    // source of truth.
    const byIndex = new Map<number, readonly number[]>()
    for (const entry of data) {
      const record = requireRecord(entry, 'data[] entry')
      const index = record.index
      const embedding = record.embedding
      if (typeof index !== 'number' || !Array.isArray(embedding)) {
        throw new ModelProtocolError(
          'data[] entry lacks index or embedding',
          payload,
        )
      }
      byIndex.set(index, embedding as readonly number[])
    }

    const vectors: number[][] = []
    for (let index = 0; index < inputs.length; index += 1) {
      const vector = byIndex.get(index)
      if (vector === undefined) {
        throw new ModelProtocolError(
          `Embedding for index ${index} is missing`,
          payload,
        )
      }
      if (vector.length !== this.space.dimensions) {
        throw new ModelProtocolError(
          `Embedding for index ${index} has ${vector.length} dimensions; space "${this.space.id}" declares ${this.space.dimensions}`,
        )
      }
      vectors.push([...vector])
    }
    return vectors
  }
}
