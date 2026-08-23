# pgvector plugin

PostgreSQL pgvector adapter for the shared `VectorStore` contract (ADR 0005:
independent plugin, validates dimensions, never bypasses workspace
authorization; ADR 0006: vectors live in their own tables, never in event
tables). Runs the same dialect-agnostic contract suite pattern as the
storage plugins (`@bee-agent/vector-store/testing`).

- `PgvectorStore` — pooled upsert/search/delete where every statement is
  scoped by `workspace_id`; re-embedding a chunk replaces its vector in
  place (`(workspace_id, chunk_id, embedding_space_id)` conflict target).
- Embedding-space validation via a registry table: dimensions are learned
  from the first vector when only upsert traffic has been seen, model and
  metric freeze once a search (or explicit registration) describes the
  space, and mismatches fail with explicit errors.
- All three metrics map to their pgvector operators — cosine `<=>`,
  euclidean `<->`, inner product `<#>` — and `score` is the raw distance
  value (lower is more similar; inner product is negated).
- Optional metadata filtering uses JSONB containment (`metadata @>`).

The `vector` column is untyped, so searches are exact scans; per-space
typed columns with HNSW/IVFFlat indexes are a later stage.

## Running the integration tests

The suite needs a real PostgreSQL with the pgvector extension and skips
when the URL is absent:

```bash
docker run -d --name bee-agent-pg \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=bee_agent \
  -p 127.0.0.1:5432:5432 pgvector/pgvector:pg17

BEE_AGENT_STORAGE_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/bee_agent \
  pnpm --filter @bee-agent/plugin-vector-pgvector test
```
