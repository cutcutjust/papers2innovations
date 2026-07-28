PRAGMA foreign_keys = ON;

ALTER TABLE translations ADD COLUMN source_start INTEGER NOT NULL DEFAULT 0;
ALTER TABLE translations ADD COLUMN source_end INTEGER NOT NULL DEFAULT -1;
ALTER TABLE translations ADD COLUMN segments_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE translations ADD COLUMN terms_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS context_scopes (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK(scope_type IN ('paper', 'research')),
  paper_id TEXT REFERENCES papers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((scope_type = 'paper' AND paper_id IS NOT NULL) OR (scope_type = 'research' AND paper_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_context_scopes_paper
  ON context_scopes(paper_id) WHERE scope_type = 'paper';

CREATE TABLE IF NOT EXISTS context_scope_items (
  scope_id TEXT NOT NULL REFERENCES context_scopes(id) ON DELETE CASCADE,
  context_item_id TEXT NOT NULL REFERENCES context_items(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK(item_type IN ('markdown', 'compressed_markdown', 'custom')),
  title TEXT NOT NULL DEFAULT '',
  custom_text TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(scope_id, context_item_id)
);

INSERT OR IGNORE INTO context_scopes(id, scope_type, paper_id, name, created_at, updated_at)
VALUES('research:default', 'research', NULL, '多论文研究上下文',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT OR IGNORE INTO context_scope_items(
  scope_id, context_item_id, item_type, title, custom_text, sort_order, created_at, updated_at
)
SELECT 'research:default', id,
       CASE WHEN mode = 'compressed' THEN 'compressed_markdown' ELSE 'markdown' END,
       '', NULL, ROW_NUMBER() OVER (ORDER BY created_at, id), created_at, updated_at
FROM context_items;

CREATE TABLE IF NOT EXISTS reader_annotations (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  section_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  source_start INTEGER NOT NULL,
  source_end INTEGER NOT NULL,
  annotation_type TEXT NOT NULL CHECK(annotation_type IN ('translation', 'chat')),
  related_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(paper_id, block_id, source_start, source_end, annotation_type, related_id)
);

CREATE INDEX IF NOT EXISTS idx_reader_annotations_paper
  ON reader_annotations(paper_id, block_id, source_start);

CREATE TABLE IF NOT EXISTS formula_repairs (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  section_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  page INTEGER,
  source_hash TEXT NOT NULL,
  original_text TEXT NOT NULL,
  repaired_latex TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  model_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  cache_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS figure_analyses (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  figure_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  model_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'failed')),
  description TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  cache_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(paper_id, figure_id, model_id, prompt_version)
);

CREATE INDEX IF NOT EXISTS idx_figure_analyses_paper
  ON figure_analyses(paper_id, figure_id);

CREATE TABLE IF NOT EXISTS preprocess_quality (
  paper_id TEXT PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  formula_issue_count INTEGER NOT NULL DEFAULT 0,
  repaired_formula_count INTEGER NOT NULL DEFAULT 0,
  figure_count INTEGER NOT NULL DEFAULT 0,
  analyzed_figure_count INTEGER NOT NULL DEFAULT 0,
  failed_figure_count INTEGER NOT NULL DEFAULT 0,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
