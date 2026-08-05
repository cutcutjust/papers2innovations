PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS visual_regions (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES document_revisions(id) ON DELETE CASCADE,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  region_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  bbox_json TEXT NOT NULL,
  image_hash TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'partial', 'failed', 'unknown')),
  model_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  artifact_path TEXT,
  confidence REAL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 1,
  error_kind TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(revision_id, region_key)
);

CREATE INDEX IF NOT EXISTS idx_visual_regions_paper_page
  ON visual_regions(paper_id, page, sequence);

CREATE INDEX IF NOT EXISTS idx_visual_regions_cache
  ON visual_regions(cache_key, status);

ALTER TABLE preprocess_quality ADD COLUMN total_region_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE preprocess_quality ADD COLUMN completed_region_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE preprocess_quality ADD COLUMN failed_region_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE preprocess_quality ADD COLUMN unknown_region_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE preprocess_quality ADD COLUMN vision_model_id TEXT;
