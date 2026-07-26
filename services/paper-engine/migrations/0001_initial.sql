PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS papers (
  id TEXT PRIMARY KEY,
  canonical_sha256 TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  page_count INTEGER NOT NULL DEFAULT 0,
  markdown_path TEXT,
  document_path TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_files (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  absolute_path TEXT NOT NULL UNIQUE,
  relative_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  modified_at_ns INTEGER NOT NULL,
  is_missing INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_paper_files_sha256 ON paper_files(sha256);
CREATE INDEX IF NOT EXISTS idx_paper_files_paper_id ON paper_files(paper_id);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  paper_id TEXT REFERENCES papers(id) ON DELETE SET NULL,
  paper_file_id TEXT REFERENCES paper_files(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  error TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_paper_id ON jobs(paper_id);

CREATE TABLE IF NOT EXISTS parse_runs (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  parser_name TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS sections (
  id TEXT NOT NULL,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  level INTEGER NOT NULL,
  sort_order INTEGER NOT NULL,
  page_start INTEGER,
  page_end INTEGER,
  markdown TEXT NOT NULL,
  anchors_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (paper_id, id)
);

CREATE TABLE IF NOT EXISTS figures (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  caption TEXT,
  relative_path TEXT NOT NULL,
  page INTEGER,
  bbox_json TEXT,
  mime_type TEXT NOT NULL
);
