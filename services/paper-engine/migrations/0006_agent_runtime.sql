PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agent_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  color TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  max_context_tokens INTEGER NOT NULL,
  max_output_tokens INTEGER NOT NULL,
  context_safety_ratio REAL NOT NULL,
  temperature REAL NOT NULL,
  reasoning_effort TEXT,
  timeout_seconds INTEGER NOT NULL,
  max_retries INTEGER NOT NULL,
  max_cost_per_run REAL,
  max_cost_per_day REAL,
  allowed_tools_json TEXT NOT NULL,
  network_policy TEXT NOT NULL,
  write_policy TEXT NOT NULL,
  system_prompt_id TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
  retry_of TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  user_prompt TEXT NOT NULL,
  context_snapshot_json TEXT NOT NULL,
  output_text TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_profiles_updated
  ON agent_profiles(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_runs_profile
  ON agent_runs(agent_profile_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_runs_status
  ON agent_runs(status, updated_at DESC);
