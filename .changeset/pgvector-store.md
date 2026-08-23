---
'@bee-agent/contracts': minor
'@bee-agent/vector-store': minor
'@bee-agent/plugin-vector-pgvector': minor
'@bee-agent/server': minor
---

Added the pgvector stage: Vector Store adapter with embedding-space validation (ADR 0005/0006).

- `@bee-agent/vector-store`: new `@bee-agent/vector-store/testing` export with `defineVectorStoreContractSuite`, the dialect-agnostic VectorStore contract suite (roundtrip and ranking, workspace isolation, workspace-scoped deletion, limit, metadata containment, in-place re-embedding, dimension-violation rejection); consumers inject their vitest test APIs like the storage suite.
- `@bee-agent/contracts`: `VectorSearchResult.score` is documented as the raw distance in the space's metric (lower is more similar; inner product is negated).
- `@bee-agent/plugin-vector-pgvector`: `PgvectorStore` on pg — every statement scoped by `workspace_id`, re-embedding replaces a chunk's vector in place, cosine/euclidean/inner-product operators from a whitelist, optional JSONB metadata filters, and an embedding-space registry that learns dimensions from the first upsert, freezes model/metric once a search describes the space, and rejects mismatches with explicit errors. Vectors live in dedicated tables, never in event tables. Integration tests run against a real pgvector-enabled PostgreSQL via `BEE_AGENT_STORAGE_POSTGRES_URL` and skip without it.
- `@bee-agent/server`: `vectorStore: 'pgvector'` option (env `BEE_AGENT_VECTOR_STORE`) mounts the plugin under the kernel's `vector-store` service key; requires `postgresUrl` and fails fast otherwise.
