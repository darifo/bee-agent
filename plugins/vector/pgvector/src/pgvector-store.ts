import pg from 'pg'
import type { Pool, QueryResult, QueryResultRow } from 'pg'
import { z } from 'zod'
import {
  EmbeddingRecordSchema,
  VectorSearchQuerySchema,
} from '@bee-agent/contracts'
import type {
  EmbeddingRecord,
  EmbeddingSpace,
  VectorSearchQuery,
  VectorSearchResult,
} from '@bee-agent/contracts'
import type { VectorStore } from '@bee-agent/vector-store'
import { initialMigration } from './migration.ts'

// Whitelist mapping — the operator is interpolated into SQL, so it can
// never come from caller input.
const DISTANCE_OPERATORS = {
  cosine: '<=>',
  euclidean: '<->',
  inner_product: '<#>',
} as const

interface SpaceRow {
  dimensions: number
  model: string | null
  metric: string | null
}

interface EmbeddingRow {
  id: string
  chunk_id: string
  workspace_id: string
  embedding_space_id: string
  vector: string
  metadata: unknown
  score: number
}

export class PgvectorStore implements VectorStore {
  readonly #pool: Pool
  #closed = false

  constructor(connectionString: string) {
    this.#pool = new pg.Pool({ connectionString, max: 5 })
  }

  /** Idempotent: safe to run on every start. */
  async migrate(): Promise<void> {
    try {
      await this.#pool.query(initialMigration)
    } catch (error) {
      if (
        error instanceof Error &&
        /extension "vector"|could not open extension control file/i.test(
          error.message,
        )
      ) {
        throw new Error(
          `pgvector is unavailable on this PostgreSQL server: ${error.message}. ` +
            'Use an image with pgvector installed (for example pgvector/pgvector:pg17).',
          { cause: error },
        )
      }
      throw error
    }
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      await this.#pool.end()
      this.#closed = true
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }

  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    return this.#pool.query<R>(
      text,
      params === undefined ? undefined : [...params],
    )
  }

  /**
   * Registers the space or validates the caller's description against the
   * registry: dimensions must always match; model and metric are learned
   * from the first complete description and then frozen. This is the
   * embedding-space validation ADR 0005 demands.
   */
  async #ensureSpace(space: EmbeddingSpace): Promise<void> {
    await this.#pool.query(
      `INSERT INTO vector_embedding_spaces
         (embedding_space_id, dimensions, model, metric, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (embedding_space_id) DO NOTHING`,
      [
        space.id,
        space.dimensions,
        space.model,
        space.metric,
        new Date().toISOString(),
      ],
    )

    const existing = await this.#registeredSpace(space.id)
    if (existing === undefined) {
      throw new Error(`Failed to register embedding space "${space.id}"`)
    }
    if (existing.dimensions !== space.dimensions) {
      throw new Error(
        `Embedding space "${space.id}" holds ${existing.dimensions}-dimensional vectors; got ${space.dimensions} dimensions`,
      )
    }
    if (existing.model === null || existing.metric === null) {
      // First complete description fills what upsert-only traffic could not.
      await this.#pool.query(
        `UPDATE vector_embedding_spaces
         SET model = $2, metric = $3
         WHERE embedding_space_id = $1 AND (model IS NULL OR metric IS NULL)`,
        [space.id, space.model, space.metric],
      )
      return
    }
    if (existing.model !== space.model || existing.metric !== space.metric) {
      throw new Error(
        `Embedding space "${space.id}" is registered as ${existing.model}/${existing.metric}; got ${space.model}/${space.metric}`,
      )
    }
  }

  async #registeredSpace(
    embeddingSpaceId: string,
  ): Promise<SpaceRow | undefined> {
    const result = await this.#pool.query<SpaceRow>(
      `SELECT dimensions, model, metric
       FROM vector_embedding_spaces
       WHERE embedding_space_id = $1`,
      [embeddingSpaceId],
    )
    return result.rows[0]
  }

  async upsert(record: EmbeddingRecord): Promise<void> {
    const parsed = EmbeddingRecordSchema.parse(record)
    if (parsed.vector.length === 0) {
      throw new Error('Embedding vectors must have at least one dimension')
    }

    // Learn the space's dimensions from the first vector if no search has
    // registered it yet; a concurrent registration loses the race and is
    // validated by the re-read below.
    await this.#pool.query(
      `INSERT INTO vector_embedding_spaces
         (embedding_space_id, dimensions, model, metric, created_at)
       VALUES ($1, $2, NULL, NULL, $3)
       ON CONFLICT (embedding_space_id) DO NOTHING`,
      [parsed.embeddingSpaceId, parsed.vector.length, new Date().toISOString()],
    )
    const registered = await this.#registeredSpace(parsed.embeddingSpaceId)
    if (registered === undefined) {
      throw new Error(
        `Failed to register embedding space "${parsed.embeddingSpaceId}"`,
      )
    }
    if (registered.dimensions !== parsed.vector.length) {
      throw new Error(
        `Embedding space "${parsed.embeddingSpaceId}" holds ${registered.dimensions}-dimensional vectors; got ${parsed.vector.length} dimensions`,
      )
    }

    await this.#pool.query(
      `INSERT INTO vector_embeddings
         (id, chunk_id, workspace_id, embedding_space_id, vector, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::vector, $6::jsonb, $7, $7)
       ON CONFLICT (workspace_id, chunk_id, embedding_space_id)
       DO UPDATE SET
         id = EXCLUDED.id,
         vector = EXCLUDED.vector,
         metadata = EXCLUDED.metadata,
         updated_at = EXCLUDED.updated_at`,
      [
        parsed.id,
        parsed.chunkId,
        parsed.workspaceId,
        parsed.embeddingSpaceId,
        JSON.stringify(parsed.vector),
        JSON.stringify(parsed.metadata),
        new Date().toISOString(),
      ],
    )
  }

  async search(query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    const parsed = VectorSearchQuerySchema.parse(query)
    if (parsed.vector.length !== parsed.embeddingSpace.dimensions) {
      throw new Error(
        `Embedding space "${parsed.embeddingSpace.id}" declares ${parsed.embeddingSpace.dimensions} dimensions; query vector has ${parsed.vector.length}`,
      )
    }
    await this.#ensureSpace(parsed.embeddingSpace)

    const operator = DISTANCE_OPERATORS[parsed.embeddingSpace.metric]
    const params: unknown[] = [
      parsed.workspaceId,
      parsed.embeddingSpace.id,
      JSON.stringify(parsed.vector),
      parsed.limit,
    ]
    let filter = ''
    if (parsed.metadata !== undefined) {
      params.push(JSON.stringify(parsed.metadata))
      filter = ' AND metadata @> $5::jsonb'
    }

    const result = await this.#pool.query<EmbeddingRow>(
      `SELECT id, chunk_id, workspace_id, embedding_space_id,
              vector::text AS vector, metadata,
              (vector ${operator} $3::vector) AS score
       FROM vector_embeddings
       WHERE workspace_id = $1 AND embedding_space_id = $2${filter}
       ORDER BY vector ${operator} $3::vector
       LIMIT $4`,
      params,
    )
    return result.rows.map((row) => ({
      record: EmbeddingRecordSchema.parse({
        id: row.id,
        chunkId: row.chunk_id,
        workspaceId: row.workspace_id,
        embeddingSpaceId: row.embedding_space_id,
        vector: JSON.parse(row.vector) as number[],
        metadata: row.metadata,
      }),
      score: Number(row.score),
    }))
  }

  async delete(id: string, workspaceId: string): Promise<void> {
    const recordId = z.uuid().parse(id)
    await this.#pool.query(
      'DELETE FROM vector_embeddings WHERE id = $1 AND workspace_id = $2',
      [recordId, workspaceId],
    )
  }
}
