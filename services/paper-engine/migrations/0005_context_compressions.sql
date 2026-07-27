PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS context_compressions (
  id TEXT PRIMARY KEY,
  context_item_id TEXT NOT NULL REFERENCES context_items(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  compressed_text TEXT NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  model_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  revision INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(context_item_id, source_hash, model_id, prompt_version, revision)
);

ALTER TABLE context_items
  ADD COLUMN active_compression_id TEXT REFERENCES context_compressions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_context_compressions_cache
  ON context_compressions(context_item_id, source_hash, model_id, prompt_version, revision DESC);
