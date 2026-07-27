PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS context_items (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  section_id TEXT NOT NULL DEFAULT '',
  block_id TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  source_text TEXT NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(paper_id, section_id, block_id)
);

CREATE INDEX IF NOT EXISTS idx_context_items_paper
  ON context_items(paper_id, updated_at);
