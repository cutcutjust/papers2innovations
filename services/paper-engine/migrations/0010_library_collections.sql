PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS library_collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES library_collections(id) ON DELETE CASCADE,
  color TEXT NOT NULL DEFAULT '#4f6bed',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_library_collections_sibling_name
  ON library_collections(COALESCE(parent_id, ''), name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_library_collections_parent
  ON library_collections(parent_id, sort_order, name);

CREATE TABLE IF NOT EXISTS paper_collections (
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL REFERENCES library_collections(id) ON DELETE CASCADE,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (paper_id, collection_id)
);

CREATE INDEX IF NOT EXISTS idx_paper_collections_collection
  ON paper_collections(collection_id, paper_id);

INSERT OR IGNORE INTO library_collections(id, name, parent_id, color, sort_order, created_at, updated_at)
SELECT 'source-zotero', 'Zotero', NULL, '#3984d8', 0, MIN(imported_at), MAX(imported_at)
FROM paper_sources
WHERE source_type = 'zotero' AND source_collection IS NOT NULL
HAVING COUNT(*) > 0;

INSERT OR IGNORE INTO library_collections(id, name, parent_id, color, sort_order, created_at, updated_at)
SELECT 'source-zotero-' || lower(hex(randomblob(16))), source_collection, 'source-zotero', '#4f6bed',
       ROW_NUMBER() OVER (ORDER BY source_collection), MIN(imported_at), MAX(imported_at)
FROM paper_sources
WHERE source_type = 'zotero' AND source_collection IS NOT NULL
GROUP BY source_collection;

INSERT OR IGNORE INTO paper_collections(paper_id, collection_id, assigned_at)
SELECT ps.paper_id, lc.id, ps.imported_at
FROM paper_sources ps
JOIN library_collections lc
  ON lc.parent_id = 'source-zotero' AND lc.name = ps.source_collection COLLATE NOCASE
WHERE ps.source_type = 'zotero' AND ps.source_collection IS NOT NULL;
