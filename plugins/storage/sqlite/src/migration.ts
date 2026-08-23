export const initialMigration = `
CREATE TABLE IF NOT EXISTS task_sequences (
  task_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL DEFAULT 0 CHECK (sequence >= 0)
);

CREATE TABLE IF NOT EXISTS agent_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, sequence)
);

CREATE INDEX IF NOT EXISTS agent_events_task_sequence_idx
  ON agent_events (task_id, sequence);
`
