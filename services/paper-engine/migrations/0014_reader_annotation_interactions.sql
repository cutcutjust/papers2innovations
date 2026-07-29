PRAGMA foreign_keys = ON;

ALTER TABLE reader_annotations ADD COLUMN target_type TEXT NOT NULL DEFAULT 'conversation'
  CHECK(target_type IN ('translation', 'chat_turn', 'analysis', 'conversation'));
ALTER TABLE reader_annotations ADD COLUMN selected_text TEXT NOT NULL DEFAULT '';
ALTER TABLE reader_annotations ADD COLUMN anchor_hash TEXT NOT NULL DEFAULT '';

UPDATE reader_annotations
SET target_type = CASE annotation_type
  WHEN 'translation' THEN 'translation'
  ELSE 'conversation'
END;

CREATE TABLE IF NOT EXISTS reader_chat_turn_revisions (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES reader_chat_turns(id) ON DELETE CASCADE,
  user_message TEXT NOT NULL,
  context_snapshot_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(turn_id, revision)
);

INSERT OR IGNORE INTO reader_chat_turn_revisions(
  id, turn_id, user_message, context_snapshot_json, revision, created_at
)
SELECT lower(hex(randomblob(16))), id, user_message, context_snapshot_json, 1, created_at
FROM reader_chat_turns;

INSERT OR IGNORE INTO reader_annotations(
  id, paper_id, section_id, block_id, source_hash, source_start, source_end,
  annotation_type, related_id, created_at, updated_at,
  target_type, selected_text, anchor_hash
)
SELECT
  lower(hex(randomblob(16))), t.paper_id, t.section_id, t.block_id, t.source_hash,
  MAX(0, t.source_start),
  CASE WHEN t.source_end < t.source_start THEN length(t.source_text) ELSE t.source_end END,
  'translation', t.id, t.created_at, t.updated_at,
  'translation', t.source_text, ''
FROM translations t
JOIN (
  SELECT paper_id, block_id, target_language, MAX(revision) AS revision
  FROM translations
  GROUP BY paper_id, block_id, target_language
) latest ON latest.paper_id = t.paper_id
  AND latest.block_id = t.block_id
  AND latest.target_language = t.target_language
  AND latest.revision = t.revision;

INSERT OR IGNORE INTO reader_annotations(
  id, paper_id, section_id, block_id, source_hash, source_start, source_end,
  annotation_type, related_id, created_at, updated_at,
  target_type, selected_text, anchor_hash
)
SELECT
  lower(hex(randomblob(16))), a.paper_id, a.section_id, a.block_id, a.source_hash,
  0, length(a.source_text), 'chat', a.id, a.created_at, a.updated_at,
  'analysis', a.source_text, ''
FROM reader_analyses a
JOIN (
  SELECT paper_id, block_id, analysis_type, MAX(revision) AS revision
  FROM reader_analyses
  GROUP BY paper_id, block_id, analysis_type
) latest ON latest.paper_id = a.paper_id
  AND latest.block_id = a.block_id
  AND latest.analysis_type = a.analysis_type
  AND latest.revision = a.revision;

CREATE INDEX IF NOT EXISTS idx_reader_annotations_target
  ON reader_annotations(paper_id, target_type, related_id);

CREATE INDEX IF NOT EXISTS idx_reader_chat_turn_revisions_turn
  ON reader_chat_turn_revisions(turn_id, revision DESC);
