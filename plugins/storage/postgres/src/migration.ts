/**
 * PostgreSQL counterpart of the SQLite initial migration. `created_order`
 * has no SQLite twin: it reproduces SQLite's implicit `rowid` insertion
 * ordering so `EventStore.listTaskIds()` can stay oldest-first on both
 * dialects.
 */
export const initialMigration = `
CREATE TABLE IF NOT EXISTS task_sequences (
  task_id TEXT PRIMARY KEY,
  sequence BIGINT NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  created_order BIGINT GENERATED ALWAYS AS IDENTITY
);

CREATE TABLE IF NOT EXISTS agent_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, sequence)
);

CREATE INDEX IF NOT EXISTS agent_events_task_sequence_idx
  ON agent_events (task_id, sequence);
`
