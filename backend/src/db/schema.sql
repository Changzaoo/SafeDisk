CREATE TABLE IF NOT EXISTS transfer_history (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  source_path TEXT NOT NULL,
  destination_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  hash_source TEXT,
  hash_destination TEXT,
  status TEXT NOT NULL CHECK (status IN ('success', 'error', 'canceled')),
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_transfer_history_timestamp
ON transfer_history(timestamp DESC);
