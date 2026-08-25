import { randomUUID } from 'node:crypto'
import {
  CreateMemoryDocumentRequestSchema,
  MemoryChunkSchema,
  MemoryDocumentSchema,
  MemoryRecallRequestSchema,
} from '@bee-agent/contracts'
import type {
  CreateMemoryDocumentRequest,
  MemoryChunk,
  MemoryDocument,
  MemoryRecallResult,
} from '@bee-agent/contracts'
import { vectorStoreService } from '@bee-agent/kernel'
import type { Kernel } from '@bee-agent/kernel'
import type { VectorStore } from '@bee-agent/vector-store'
import { MockEmbedder } from './embedder.ts'
import type { Embedder } from './embedder.ts'
import { chunkDocument } from './memory-chunker.ts'

/**
 * Reserved top-level key on embedding-record metadata: it carries the full
 * {@link MemoryChunk} payload so recall can rebuild chunks without a second
 * store. Document metadata shares the top level, which keeps JSONB metadata
 * filters working on user keys.
 */
export const MEMORY_CHUNK_METADATA_KEY = 'chunk'

export class MemoryRuntimeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryRuntimeError'
  }
}

export interface MemoryRuntimeOptions {
  /** Embedder whose space owns every vector; defaults to MockEmbedder. */
  readonly embedder?: Embedder | undefined
  /** Vector Store override for tests; resolved from the kernel otherwise. */
  readonly vectorStore?: VectorStore | undefined
  /** Maximum characters per chunk; defaults to 512. */
  readonly chunkSize?: number | undefined
}

export interface RememberedDocument {
  readonly document: MemoryDocument
  readonly chunks: readonly MemoryChunk[]
}

export interface MemoryRecallQuery {
  readonly workspaceId: string
  readonly text: string
  readonly limit?: number | undefined
  readonly metadata?: Record<string, unknown> | undefined
}

const DEFAULT_CHUNK_SIZE = 512

/**
 * Server-mode semantic memory (ADR 0005/0006): documents are chunked,
 * embedded by the configured embedder, and stored as Vector Store records
 * in the embedder's own embedding space. Task events never carry vectors;
 * switching embedders switches spaces instead of corrupting old records.
 */
export class MemoryRuntime {
  readonly #kernel: Kernel
  readonly #embedder: Embedder
  readonly #explicitStore: VectorStore | undefined
  readonly #chunkSize: number
  #storePromise: Promise<VectorStore> | undefined

  constructor(kernel: Kernel, options: MemoryRuntimeOptions = {}) {
    this.#kernel = kernel
    this.#embedder = options.embedder ?? new MockEmbedder()
    this.#explicitStore = options.vectorStore
    this.#chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE
  }

  get embedder(): Embedder {
    return this.#embedder
  }

  /** Chunks, embeds, and stores a document in the workspace's memory. */
  async remember(
    request: CreateMemoryDocumentRequest,
  ): Promise<RememberedDocument> {
    const parsed = CreateMemoryDocumentRequestSchema.parse(request)
    const now = new Date().toISOString()
    const document = MemoryDocumentSchema.parse({
      id: randomUUID(),
      workspaceId: parsed.workspaceId,
      content: parsed.content,
      metadata: parsed.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    })
    const chunks = chunkDocument(document, this.#chunkSize)
    if (chunks.length === 0) {
      throw new MemoryRuntimeError(
        'Document produced no chunks (content has no words)',
      )
    }

    const vectors = await this.#embedder.embed(
      chunks.map((chunk) => chunk.content),
    )
    if (vectors.length !== chunks.length) {
      throw new MemoryRuntimeError(
        `Embedder returned ${vectors.length} vectors for ${chunks.length} chunks`,
      )
    }

    const store = await this.#resolveVectorStore()
    for (const [index, chunk] of chunks.entries()) {
      const vector = vectors[index]
      if (vector === undefined) {
        throw new MemoryRuntimeError(`Embedder returned no vector #${index}`)
      }
      await store.upsert({
        id: chunk.id,
        chunkId: chunk.id,
        workspaceId: chunk.workspaceId,
        embeddingSpaceId: this.#embedder.space.id,
        vector: [...vector],
        metadata: {
          ...document.metadata,
          [MEMORY_CHUNK_METADATA_KEY]: chunk,
        },
      })
    }
    return { document, chunks }
  }

  /** Embeds the query and returns the nearest memory chunks, best first. */
  async recall(query: MemoryRecallQuery): Promise<MemoryRecallResult[]> {
    const parsed = MemoryRecallRequestSchema.parse(query)
    const [queryVector] = await this.#embedder.embed([parsed.text])
    if (queryVector === undefined) {
      throw new MemoryRuntimeError('Embedder returned no query vector')
    }

    const store = await this.#resolveVectorStore()
    const results = await store.search({
      workspaceId: parsed.workspaceId,
      embeddingSpace: this.#embedder.space,
      vector: [...queryVector],
      limit: parsed.limit,
      ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
    })
    return results.map((result) => ({
      chunk: MemoryChunkSchema.parse(
        result.record.metadata[MEMORY_CHUNK_METADATA_KEY],
      ),
      score: result.score,
    }))
  }

  /** Drops one chunk from the workspace's memory. */
  async forget(chunkId: string, workspaceId: string): Promise<void> {
    const store = await this.#resolveVectorStore()
    await store.delete(chunkId, workspaceId)
  }

  async #resolveVectorStore(): Promise<VectorStore> {
    if (this.#explicitStore) return this.#explicitStore
    this.#storePromise ??= this.#kernel.waitForService(vectorStoreService)
    return this.#storePromise
  }
}
