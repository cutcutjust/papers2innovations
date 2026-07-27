PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS reader_analyses (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  section_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  analysis_type TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  source_text TEXT NOT NULL,
  adjacent_context TEXT NOT NULL,
  result_text TEXT NOT NULL,
  model_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  revision INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(paper_id, block_id, analysis_type, revision)
);

CREATE TABLE IF NOT EXISTS reader_conversations (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL UNIQUE REFERENCES papers(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reader_chat_turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES reader_conversations(id) ON DELETE CASCADE,
  turn_index INTEGER NOT NULL,
  user_message TEXT NOT NULL,
  context_snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(conversation_id, turn_index)
);

CREATE TABLE IF NOT EXISTS reader_chat_responses (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES reader_chat_turns(id) ON DELETE CASCADE,
  assistant_text TEXT NOT NULL,
  model_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(turn_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_reader_analyses_latest
  ON reader_analyses(paper_id, block_id, analysis_type, revision DESC);

CREATE INDEX IF NOT EXISTS idx_reader_chat_turns_conversation
  ON reader_chat_turns(conversation_id, turn_index);

CREATE INDEX IF NOT EXISTS idx_reader_chat_responses_latest
  ON reader_chat_responses(turn_id, revision DESC);
