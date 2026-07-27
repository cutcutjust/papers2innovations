PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agent_tool_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  position INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, tool_call_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_run
  ON agent_tool_calls(run_id, iteration, position);
