PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS file_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  absolute_path TEXT NOT NULL,
  previous_path TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  processed_at TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_file_events_status_created
  ON file_events(status, created_at);

CREATE TABLE IF NOT EXISTS job_stages (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 1,
  artifact_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(job_id, stage)
);

CREATE INDEX IF NOT EXISTS idx_job_stages_job ON job_stages(job_id);

CREATE TABLE IF NOT EXISTS paper_sources (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_item_key TEXT,
  source_attachment_key TEXT,
  source_collection TEXT,
  source_path TEXT,
  source_modified_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  imported_at TEXT NOT NULL,
  UNIQUE(source_type, source_attachment_key)
);

CREATE INDEX IF NOT EXISTS idx_paper_sources_paper ON paper_sources(paper_id);

CREATE TABLE IF NOT EXISTS tables (
  id TEXT NOT NULL,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  caption TEXT,
  markdown_path TEXT,
  csv_path TEXT,
  page INTEGER,
  bbox_json TEXT,
  PRIMARY KEY (paper_id, id)
);

CREATE TABLE IF NOT EXISTS page_maps (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  width REAL NOT NULL,
  height REAL NOT NULL,
  text_source TEXT NOT NULL,
  alignment_confidence REAL,
  ocr_cache_key TEXT,
  bbox_json TEXT,
  UNIQUE(paper_id, page)
);

ALTER TABLE parse_runs ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE parse_runs ADD COLUMN artifact_manifest_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE figures ADD COLUMN thumbnail_path TEXT;
ALTER TABLE figures ADD COLUMN page_width REAL;
ALTER TABLE figures ADD COLUMN page_height REAL;
ALTER TABLE figures ADD COLUMN coordinate_space TEXT NOT NULL DEFAULT 'normalized-top-left';

