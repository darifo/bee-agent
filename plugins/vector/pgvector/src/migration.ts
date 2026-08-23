/**
 * Vector data lives in its own tables, never in event tables (ADR 0006).
 * The `vector` column is deliberately untyped — dimensions differ per
 * embedding space, and the space registry is what validates them — at the
 * cost of exact scans until per-space indexes arrive in a later stage.
 */
export const initialMigration = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS vector_embedding_spaces (
  embedding_space_id TEXT PRIMARY KEY,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  model TEXT,
  metric TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vector_embeddings (
  id UUID PRIMARY KEY,
  chunk_id UUID NOT NULL,
  workspace_id TEXT NOT NULL,
  embedding_space_id TEXT NOT NULL
    REFERENCES vector_embedding_spaces (embedding_space_id),
  vector vector NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, chunk_id, embedding_space_id)
);

CREATE INDEX IF NOT EXISTS vector_embeddings_scope_idx
  ON vector_embeddings (workspace_id, embedding_space_id);
`
