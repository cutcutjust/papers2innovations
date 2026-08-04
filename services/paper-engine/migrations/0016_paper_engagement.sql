PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS paper_engagement (
  paper_id TEXT PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
  is_favorite INTEGER NOT NULL DEFAULT 0 CHECK(is_favorite IN (0, 1)),
  favorited_at TEXT,
  last_opened_at TEXT,
  last_read_at TEXT,
  last_section_id TEXT,
  last_page INTEGER CHECK(last_page IS NULL OR last_page >= 1),
  reading_progress REAL NOT NULL DEFAULT 0 CHECK(reading_progress >= 0 AND reading_progress <= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_paper_engagement_favorites
  ON paper_engagement(is_favorite, favorited_at DESC);

CREATE INDEX IF NOT EXISTS idx_paper_engagement_reading
  ON paper_engagement(last_read_at DESC);
