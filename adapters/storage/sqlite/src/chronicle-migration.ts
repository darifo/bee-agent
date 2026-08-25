export const chronicleMigration = `
CREATE TABLE IF NOT EXISTS chronicle_streams (
  stream_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL DEFAULT 0 CHECK (sequence >= 0)
);

CREATE TABLE IF NOT EXISTS chronicle_events (
  stream_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_id TEXT NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY (stream_id, sequence)
);
`
