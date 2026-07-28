PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agent_prompts (
  id TEXT PRIMARY KEY,
  agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_prompts_profile_name
  ON agent_prompts(agent_profile_id, name COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_agent_prompts_profile_order
  ON agent_prompts(agent_profile_id, sort_order, updated_at DESC);

INSERT OR IGNORE INTO agent_prompts(
  id, agent_profile_id, name, content, sort_order, created_at, updated_at
)
SELECT
  'prompt:' || id || ':default',
  id,
  '默认分析任务',
  '请分析当前研究上下文，提炼最重要且有证据支持的结论，并指出证据不足之处。',
  0,
  created_at,
  updated_at
FROM agent_profiles;
