PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS document_revisions (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  pipeline_version TEXT NOT NULL,
  processing_mode TEXT NOT NULL CHECK(processing_mode IN ('vision', 'local')),
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'partial', 'failed', 'cancelled')),
  markdown_path TEXT,
  document_path TEXT,
  artifact_manifest_json TEXT NOT NULL DEFAULT '{}',
  previous_revision_id TEXT REFERENCES document_revisions(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_document_revisions_paper_created
  ON document_revisions(paper_id, created_at DESC);

CREATE TABLE IF NOT EXISTS page_recognitions (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES document_revisions(id) ON DELETE CASCADE,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  task TEXT NOT NULL,
  model_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'failed')),
  artifact_path TEXT,
  confidence REAL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(revision_id, page, task)
);

CREATE INDEX IF NOT EXISTS idx_page_recognitions_paper_page
  ON page_recognitions(paper_id, page);

CREATE INDEX IF NOT EXISTS idx_page_recognitions_cache
  ON page_recognitions(cache_key, status);

CREATE TABLE IF NOT EXISTS document_uncertainties (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES document_revisions(id) ON DELETE CASCADE,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  kind TEXT NOT NULL,
  bbox_json TEXT,
  source_text TEXT NOT NULL DEFAULT '',
  candidate_text TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0,
  resolution_status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK(resolution_status IN ('resolved', 'unresolved', 'ignored')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_document_uncertainties_paper_status
  ON document_uncertainties(paper_id, resolution_status, page);

ALTER TABLE preprocess_quality ADD COLUMN recognized_page_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE preprocess_quality ADD COLUMN cached_page_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE preprocess_quality ADD COLUMN failed_page_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE preprocess_quality ADD COLUMN uncertain_region_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE preprocess_quality ADD COLUMN removed_header_footer_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE preprocess_quality ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE preprocess_quality ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE preprocess_quality ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0;
