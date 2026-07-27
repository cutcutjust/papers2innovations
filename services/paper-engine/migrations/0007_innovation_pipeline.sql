PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS innovation_prompt_revisions (
  id TEXT PRIMARY KEY,
  prompt_text TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(prompt_version, revision)
);

CREATE TABLE IF NOT EXISTS innovation_runs (
  id TEXT PRIMARY KEY,
  retry_of TEXT REFERENCES innovation_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  current_stage TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  context_snapshot_json TEXT NOT NULL,
  stage_models_json TEXT NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS innovation_stages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES innovation_runs(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  position INTEGER NOT NULL,
  status TEXT NOT NULL,
  model_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  output_text TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, stage)
);

CREATE INDEX IF NOT EXISTS idx_innovation_runs_created
  ON innovation_runs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_innovation_stages_run
  ON innovation_stages(run_id, position);
