PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS translations (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  section_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  source_text TEXT NOT NULL,
  translated_text TEXT NOT NULL,
  target_language TEXT NOT NULL,
  model_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(paper_id, block_id, target_language, revision)
);

CREATE INDEX IF NOT EXISTS idx_translations_paper_block
  ON translations(paper_id, block_id, target_language, revision DESC);
