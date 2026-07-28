PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS prompt_templates (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK(category IN ('reader', 'translation', 'explanation', 'markdown', 'innovation')),
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_templates_category_name
  ON prompt_templates(category, name COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_prompt_templates_category_order
  ON prompt_templates(category, sort_order, updated_at DESC);

INSERT OR IGNORE INTO prompt_templates(id, category, name, content, sort_order, created_at, updated_at)
VALUES
  (
    'prompt-library:reader:default',
    'reader',
    '循证论文问答',
    '你是阅读器中的论文分析助手。请默认使用中文，只根据提供的本地论文上下文回答。每条事实性陈述都要尽可能引用论文、章节、文本块或页码；区分直接证据与推断，上下文不足时明确说明。行内公式使用 $...$，块级公式使用 $$...$$。',
    0,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  (
    'prompt-library:translation:default',
    'translation',
    '忠实学术翻译',
    '请将科研文本忠实翻译为简体中文。保留 Markdown、LaTeX、专业术语、引用、数字和不确定性，只返回译文，不要添加解释。行内公式使用 $...$，块级公式使用 $$...$$。',
    0,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  (
    'prompt-library:explanation:default',
    'explanation',
    '严谨论文解释',
    '请用中文严谨解释给定的科研内容，说明核心命题、必要假设、推理过程、作用、局限与未解决问题。不得虚构证明或结论，并引用提供的章节、文本块或页码锚点。保留原有 LaTeX。',
    0,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  (
    'prompt-library:markdown:default',
    'markdown',
    '无损 Markdown 整理',
    '你是无损科研 Markdown 整理助手。只改善结构和可读性：重建合理段落与换行，规范标题和列表，让每条参考文献独立成行，并修复明显的 OCR 断词连字符。禁止摘要、翻译、改写论点、修改引用、数字、名称、公式、表格、图片路径或添加内容。必须原样保留证据锚点，只返回 Markdown。',
    0,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  (
    'prompt-library:innovation:default',
    'innovation',
    '循证创新点提炼',
    '基于 {paper_context} 比较研究问题、方法、数据、指标和局限，区分论文直接证据与合理推断。提炼尚未解决的研究空白，提出可验证的新研究问题，并为每个想法给出假设、最小实验、失败条件和证据锚点。默认使用中文，不得虚构来源。',
    0,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );

INSERT OR IGNORE INTO prompt_templates(id, category, name, content, sort_order, created_at, updated_at)
SELECT
  'legacy:' || ap.id,
  CASE
    WHEN lower(p.id || ' ' || p.name) LIKE '%translat%' THEN 'translation'
    WHEN lower(p.id || ' ' || p.name) LIKE '%innovation%' OR lower(p.id || ' ' || p.name) LIKE '%novelty%' THEN 'innovation'
    WHEN lower(p.id || ' ' || p.name) LIKE '%figure%' OR lower(p.id || ' ' || p.name) LIKE '%citation%' THEN 'explanation'
    ELSE 'reader'
  END,
  ap.name,
  ap.content,
  ap.sort_order + 100,
  ap.created_at,
  ap.updated_at
FROM agent_prompts ap
JOIN agent_profiles p ON p.id = ap.agent_profile_id
WHERE ap.name <> '默认分析任务'
   OR ap.content <> '请分析当前研究上下文，提炼最重要且有证据支持的结论，并指出证据不足之处。';
