# Papers2Innovations 第一版执行计划

## 0. 第一版目标

第一版必须完成这一条端到端链路：

> 用户把 PDF 放入本地论文目录 → 应用自动发现并解析 → 生成带插图的 Markdown → 补全论文元数据和引用 → 用户选择论文进入指定 Agent 上下文 → AI 对多篇论文进行证据化比较 → 输出创新假设、最近似工作和最小实验方案。

第一版建议支持：

- Windows 10/11
- macOS 13+
- Ubuntu 22.04/24.04
- 单用户、本地优先
- 50～1,000 篇论文的个人论文库
- 每次选择 3～20 篇论文进行 Papers2Innovations 分析

暂不追求：

- Zotero 全部引用样式
- Word 插件
- 多设备同步
- 多用户协作
- 浏览器扩展
- 自动下载付费论文
- 全球完整论文知识图谱
- 自动运行科研实验

------

# 1. 需要先修正的两个技术定义

## 1.1 不要把上下文固定为 256K

上下文容量必须由“模型配置”决定，256K 只能作为某个 Agent 的用户限制，不能作为系统全局常量。

截至 2026 年 7 月，OpenAI 当前 GPT-5.6 系列的官方上下文窗口为 1.05M，最大输出为 128K；DeepSeek 当前 V4 Flash 和 V4 Pro 的官方上下文窗口为 1M。系统应通过 `ModelProfile` 记录模型能力，再允许用户给每个 Agent 设置一个更低的自定义上限。

最终有效上下文：

```text
effective_context_limit =
min(
  模型官方或用户录入的上下文上限,
  Agent 自定义最大上下文
)
```

例如：

```text
模型上限：1,050,000
Innovation Agent 用户上限：256,000
实际使用上限：256,000
```

## 1.2 `gpt5.6h` 不应作为模型名称

建议配置为：

```text
model = gpt-5.6
reasoning_effort = high
```

官方 API 中，`gpt-5.6` 是 GPT-5.6 Sol 的别名；`high` 是推理强度，而不是模型名称后缀。GPT-5.6 系列支持文本、图片输入和工具调用，适合 Figure Agent 和 Innovation Agent。

DeepSeek 翻译 Agent 应使用当前模型名，例如：

```text
deepseek-v4-flash
deepseek-v4-pro
```

旧的 `deepseek-chat` 和 `deepseek-reasoner` 已于 2026 年 7 月 24 日结束旧名称支持，因此不要在代码里写死旧型号。

------

# 2. 第一版产品模块

第一版拆成九个模块：

```text
1. Local Library        本地论文目录
2. Paper Ingestion      PDF导入与解析
3. Reader               PDF/Markdown阅读
4. Metadata             论文信息与引用导出
5. Citation Graph       引用及相似论文图谱
6. Agent Runtime        Agent运行时
7. Context Manager      上下文管理
8. Figure Intelligence  论文附图解析
9. Papers2Innovations   创新假设与实验设计
```

这些模块共享同一套论文数据、证据定位和 Agent 工具接口。

------

# 3. 推荐总体架构

```text
┌──────────────────────────────────────────────┐
│ Tauri 2 + React + TypeScript                 │
│                                              │
│ 论文库 / 阅读器 / 图谱 / Agent / Context Tray │
└───────────────────┬──────────────────────────┘
                    │ 双向 JSON-RPC
┌───────────────────▼──────────────────────────┐
│ Python Paper Engine                          │
│                                              │
│ PDF解析 / 元数据 / 检索 / Agent / 创新分析    │
└───────┬───────────┬──────────────┬───────────┘
        │           │              │
     Docling      GROBID       Rust Model Gateway
        │           │              │
┌───────▼───────────▼──────────────▼───────────┐
│ SQLite + FTS5 + 本地文件仓库 + Embeddings     │
└──────────────────────────────────────────────┘
```

Tauri 2 支持将外部可执行程序作为 sidecar 嵌入桌面应用，因此可以把 Python Paper Engine 分别构建成 Windows、macOS 和 Linux 版本。

## 3.1 技术栈

桌面端：

```text
Tauri 2
React
TypeScript
Zustand
TanStack Query
PDF.js
react-markdown / unified
KaTeX
Cytoscape.js
```

本地核心：

```text
Rust
SQLite
notify 文件监听
Tauri Stronghold
reqwest
```

论文引擎：

```text
Python 3.12
Pydantic
Docling
GROBID Client
httpx
lxml
numpy
scikit-learn
```

第一版不要使用复杂的多 Agent 框架。实现一个自己的：

```text
Agent Runtime
+ Tool Registry
+ Workflow Runner
+ Provider Adapter
```

这样更容易调试、记录证据和控制权限。

------

# 4. 本地论文目录设计

## 4.1 用户选择一个论文库根目录

例如：

```text
D:/Papers2Innovations-Library/
```

目录结构：

```text
Papers2Innovations-Library/
├── Papers/
│   ├── RAG/
│   │   ├── paper-a.pdf
│   │   └── paper-b.pdf
│   └── Multimodal/
│       └── paper-c.pdf
│
├── Exports/
│   ├── bibtex/
│   └── markdown/
│
└── .p2i/
    ├── library.sqlite
    ├── generated/
    │   └── <paper-id>/
    │       ├── paper.md
    │       ├── document.json
    │       ├── grobid.tei.xml
    │       ├── metadata.json
    │       ├── references.json
    │       ├── figures/
    │       └── tables/
    ├── cache/
    ├── logs/
    └── components/
```

用户只需要管理 `Papers/`。生成文件集中存入 `.p2i/`，避免在论文目录旁边产生大量图片和 JSON。

用户需要时，可以导出一个独立 Markdown 包：

```text
paper-title/
├── paper.md
├── figures/
└── tables/
```

## 4.2 文件监听规则

应用监听 `Papers/` 及其子目录：

| 文件事件         | 系统行为                       |
| ---------------- | ------------------------------ |
| 新增 PDF         | 创建解析任务                   |
| PDF 重命名       | 更新路径，不重新解析           |
| PDF 移动         | 更新集合路径                   |
| PDF 内容改变     | 建立新版本并重新解析           |
| PDF 删除         | 标记为 Missing，不立即删除数据 |
| 同一内容重复添加 | 根据 SHA-256 合并              |

必须以文件哈希识别论文文件，不能只使用路径。

建议设置 2 秒防抖，避免文件复制过程中重复触发解析。

------

# 5. PDF 解析流水线

## 5.1 完整处理流程

```text
发现 PDF
→ 等待文件写入完成
→ 计算 SHA-256
→ 检查重复
→ 创建 PaperFile
→ Docling 解析
→ 导出 Markdown
→ 提取插图和表格
→ GROBID 解析
→ 合并元数据
→ 解析参考文献
→ 外部数据源补全
→ 建立全文索引
→ 生成论文结构化卡片
→ 状态变为 Ready
```

Docling 官方支持将 PDF 输出为 Markdown 和结构化文档，也支持把插图和表格导出后，以嵌入或相对引用方式写入 Markdown。

GROBID 可提取标题、作者、摘要、参考文献、文内引用关系和正文结构，并返回部分 PDF 坐标，适合实现 Markdown 与 PDF 原文之间的定位。

## 5.2 解析任务状态

```text
DISCOVERED
HASHING
QUEUED
PARSING_LAYOUT
EXTRACTING_FIGURES
PARSING_REFERENCES
RESOLVING_METADATA
INDEXING
GENERATING_RESEARCH_CARD
READY
PARTIAL
FAILED
MISSING
```

每个阶段都要支持：

- 进度显示
- 错误详情
- 单阶段重试
- 取消
- 重新解析
- 切换解析器版本后重新生成

## 5.3 解析结果不能只有 Markdown

每篇论文必须保留：

```text
原始 PDF
Docling JSON
Markdown
GROBID TEI XML
结构化元数据
参考文献列表
插图文件
表格文件
页码与坐标映射
解析器和模型版本
```

Markdown 是阅读格式，不是最终数据源。

------

# 6. Markdown 阅读器

## 6.1 页面结构

```text
┌─────────────┬────────────────────────┬──────────────┐
│ 章节目录     │ Markdown / PDF         │ AI / 笔记     │
│             │                        │              │
│ Abstract    │ 当前正文                │ 翻译          │
│ Method      │ 图片、公式、表格         │ 解释          │
│ Experiments │                        │ 引用信息       │
└─────────────┴────────────────────────┴──────────────┘
```

阅读模式：

- Markdown
- PDF
- 左右对照
- 仅图片
- 引用上下文

## 6.2 Markdown 功能

必须支持：

- 标题目录
- KaTeX 公式
- 表格
- 图片缩放
- 图片全屏
- 引用跳转
- 段落定位 PDF
- 选中文字
- 快捷翻译
- 加入上下文
- 创建笔记
- 查找相关论文

## 6.3 证据锚点

Markdown 中每个段落设置内部锚点：

```html
<a data-paper-id="xxx"
   data-page="5"
   data-block-id="block-123">
</a>
```

AI 的证据引用必须存储：

```text
paper_id
section_id
block_id
page
bbox
source_text
```

点击 AI 回答中的证据，即可返回 PDF 原页和原文位置。

------

# 7. 论文附图 Figure Intelligence

第一版功能名称建议使用：

> Figure Reverse Engineering / 论文图示逆向工程

不要声称恢复作者真正使用过的原始 Prompt。

## 7.1 Figure Agent 输入

```text
图片原图
图片 Caption
图片前一段
图片后一段
Method 章节摘要
论文标题和摘要
图片 OCR 文本
```

## 7.2 Figure Agent 输出

```json
{
  "figure_type": "architecture_diagram",
  "scientific_explanation": "该图展示……",
  "components": [
    {
      "name": "Visual Encoder",
      "role": "提取视觉特征"
    }
  ],
  "relationships": [
    {
      "source": "Visual Encoder",
      "target": "Fusion Layer",
      "type": "feature_flow"
    }
  ],
  "recreation_prompt": "A clean academic architecture diagram...",
  "mermaid": "...",
  "graphviz": "...",
  "uncertainties": [
    "虚线箭头未在图例中定义"
  ]
}
```

## 7.3 界面操作

点击插图后显示：

```text
解释图片
生成重绘提示词
提取组件
生成 Mermaid
加入 Agent 上下文
复制图片 Caption
```

------

# 8. 元数据和引用管理

## 8.1 元数据补全顺序

```text
PDF内 DOI
→ Crossref DOI 查询
→ OpenAlex 标题查询
→ GROBID 提取结果
→ 标题与作者模糊匹配
→ AI 网络搜索补充
→ 用户确认冲突
```

Crossref 推荐使用 REST API 获取 DOI 和出版元数据，并支持通过内容协商直接返回 CSL-JSON、RIS 和 BibTeX。

OpenAlex 可以提供论文、作者、来源、主题、引用、被引和相关论文关系，适合构建局部学术图谱。

## 8.2 内部统一格式

内部以 CSL-JSON 为主：

```json
{
  "id": "paper-id",
  "type": "paper-conference",
  "title": "...",
  "author": [],
  "issued": {},
  "container-title": "...",
  "DOI": "..."
}
```

导出：

- BibTeX
- BibLaTeX
- CSL-JSON
- RIS
- LaTeX `\cite{citationKey}`

## 8.3 Citation Key

允许配置模板：

```text
{firstAuthor}{year}{firstTitleWord}
```

例如：

```text
vaswani2017attention
```

发生冲突时：

```text
vaswani2017attention
vaswani2017attentiona
```

------

# 9. CCF 和主题分类

CCF 目录必须版本化。CCF 于 2026 年 3 月 31 日发布了第七版推荐国际学术会议和期刊目录，因此不能把旧会议列表硬编码在业务代码中。

数据库：

```text
venues
- id
- canonical_name
- acronym
- type
- ccf_category
- ccf_rank
- directory_version

venue_aliases
- venue_id
- alias
```

匹配流程：

```text
论文 venue
→ 统一大小写和符号
→ 精确别名匹配
→ DOI/OpenAlex 来源校验
→ AI 提出候选
→ 用户确认低置信结果
```

主题分类组合：

```text
OpenAlex Topic
+ 标题摘要关键词
+ Embedding 聚类
+ 方法实体
+ 数据集实体
+ 用户自定义标签
```

一篇论文可以拥有多个主题：

```text
人工智能
├── 多模态学习
├── 视觉语言模型
└── 高效推理
```

------

# 10. 引用管理和论文图谱

## 10.1 第一版范围

不复刻完整 Connected Papers，只做：

> 围绕用户本地论文和一个种子论文的局部引用/相似网络。

流程：

```text
本地论文
→ 获取参考文献
→ 获取被引论文
→ 获取相关论文
→ 向外扩展一层
→ 去重
→ 计算相似度
→ 聚类
→ 图形展示
```

OpenAlex 官方 API 提供 `referenced_works`、被引查询和 `related_works`，适合实现这种局部扩展。

## 10.2 边类型

```text
CITES
CITED_BY
CO_CITED
BIBLIOGRAPHIC_COUPLING
SEMANTIC_SIMILAR
SAME_TOPIC
```

UI 中：

```text
实线：真实引用
虚线：算法相似
颜色：主题聚类
大小：引用量或局部中心性
```

## 10.3 第一版相似度

```text
相似度 =
30% 共同参考文献
+ 25% 共同被引
+ 25% 标题摘要语义相似
+ 10% 主题相似
+ 10% 方法与数据集实体相似
```

第一版图谱控制在 100～500 个可见节点。

------

# 11. Agent 架构

## 11.1 第一版 Agent

```text
Orchestrator Agent
Metadata Agent
Translation Agent
Paper Analyst Agent
Figure Agent
Citation Agent
Innovation Agent
Novelty Search Agent
Critic Agent
Experiment Designer Agent
```

这些不是十个独立服务，而是：

```text
一个 Agent Runtime
+ 多个 AgentProfile
```

## 11.2 AgentProfile

```typescript
interface AgentProfile {
  id: string;
  name: string;
  enabled: boolean;

  providerId: string;
  modelId: string;
  credentialId: string;

  maxContextTokens: number;
  maxOutputTokens: number;
  contextSafetyRatio: number;

  temperature: number;
  reasoningEffort?: string;
  timeoutSeconds: number;
  maxRetries: number;

  maxCostPerRun?: number;
  maxCostPerDay?: number;

  allowedTools: string[];
  networkPolicy: "none" | "academic" | "full";
  writePolicy: "read-only" | "confirm-write" | "trusted-write";

  systemPromptId: string;
  promptVersion: string;
}
```

## 11.3 ProviderProfile

```typescript
interface ProviderProfile {
  id: string;
  name: string;

  protocol:
    | "openai-responses"
    | "openai-compatible-chat";

  baseUrl: string;
  credentialId: string;
}
```

第一版只实现两个协议：

```text
OpenAI Responses API
OpenAI-compatible Chat Completions
```

DeepSeek 走 OpenAI-compatible adapter。

## 11.4 ModelProfile

```typescript
interface ModelProfile {
  id: string;
  providerId: string;
  modelName: string;

  contextWindowTokens: number;
  maxOutputTokens: number;

  supportsVision: boolean;
  supportsTools: boolean;
  supportsStructuredOutput: boolean;
  supportsReasoningEffort: boolean;

  capabilitySource: "official" | "user";
  tokenCounter: "provider" | "tokenizer" | "estimated";
}
```

用户填写自定义模型时显示：

```text
能力来源：用户配置
Token 统计：估算
上下文上限：未验证
```

------

# 12. Agent 工具和权限

Agent 不能直接获得任意文件系统或 Shell 权限。

必须通过 Tool Registry 调用系统功能。

## 12.1 只读工具

```text
search_library
read_paper
read_section
read_figure
find_evidence
get_metadata
get_references
get_citations
get_related_papers
search_external_papers
compare_papers
count_context_tokens
```

## 12.2 可逆写入

```text
create_note
add_tag
create_collection
update_context
create_innovation_card
export_bibtex
save_context_snapshot
```

## 12.3 高风险工具

```text
delete_paper
overwrite_metadata
batch_download
move_library
invoke_high_cost_model
```

高风险调用必须弹出确认：

```text
Innovation Agent 请求执行：

操作：搜索并加入 48 篇候选论文元数据
网络请求：预计 80～150 次
文件写入：只写入元数据，不下载 PDF
预计费用：……

[允许一次] [拒绝]
```

不要在第一版提供“始终允许所有操作”。

------

# 13. API 密钥安全

每个 Agent 可以选择不同凭据，但密钥不能存入 SQLite、JSON、日志或前端状态。

Tauri Stronghold 官方插件支持 Windows、Linux 和 macOS，可用于保存密钥和其他秘密信息。

SQLite 只保存：

```text
credential_id
provider_id
display_name
masked_hint
created_at
last_used_at
```

Stronghold 保存：

```text
credential/<credential-id>/api-key
```

推荐模型调用链：

```text
Python Agent Runtime
→ 向 Rust Model Gateway 发送标准化请求
→ Rust 根据 credentialId 读取密钥
→ Rust 调用模型 API
→ Rust 流式返回结果
→ Python 永远不接触明文密钥
```

Rust Model Gateway 第一版只需要支持：

- OpenAI Responses
- OpenAI-compatible Chat Completions
- 流式响应
- 取消
- 超时
- 重试
- Token usage
- 错误标准化

------

# 14. 上下文管理

## 14.1 Context Tray

用户可以将以下内容加入上下文：

```text
整篇论文
指定章节
指定段落
论文图片
Research Card
个人笔记
实验结果
```

## 14.2 加载模式

### 全文模式

加载整篇清洗后的论文。

适合：

- 1～3 篇核心论文
- 方法细节分析
- 公式和实验复现

### 结构化模式

仅加载：

```text
研究问题
核心假设
方法
关键公式
数据集
Baseline
主要结果
消融
贡献
限制
Future Work
```

适合比较 5～30 篇论文。

### 检索模式

论文不直接进入上下文。Agent 运行时按问题检索相关章节。

适合：

- 大论文库
- 新颖性检查
- 外部证据补充

## 14.3 容量计算

```text
safe_input_budget =
effective_context_limit
- max_output_tokens
- system_prompt_tokens
- tool_schema_tokens
- conversation_tokens
- safety_buffer_tokens
```

默认安全比例：

```text
contextSafetyRatio = 0.85
```

容量条：

```text
Innovation Agent · gpt-5.6 · high

系统提示词           6,200
工具定义             8,400
对话历史            12,300
论文全文            85,200
结构化论文          18,600
图片                 7,500
输出预留            32,000
安全缓冲            25,000
────────────────────────
预计占用           195,200 / 256,000
```

OpenAI 当前提供正式的请求 Token 计数功能，可以在发送请求前计算文本、图片、文件和工具定义占用，OpenAI Provider 应优先使用该接口。

其他 Provider：

```text
官方计数接口
→ 官方 tokenizer
→ 本地 tokenizer
→ 字符估算
```

容量条必须标记：

```text
精确
Tokenizer估算
粗略估算
```

## 14.4 超限处理

不能静默截断。

提供：

```text
移除低优先级论文
全文改为结构化
只加载选中章节
改为检索模式
切换更大上下文模型
```

任何自动压缩都要显示变化：

```text
Paper B：全文 31.2K → 结构化 4.7K
Paper D：全文 26.8K → 检索模式
```

## 14.5 Context Snapshot

每次 Agent 运行都保存：

```text
Agent 配置
模型和推理强度
论文及加载模式
章节和图片
Token 明细
Prompt 版本
工具版本
检索查询
外部检索结果
生成时间
```

以后重新运行时才能判断结果变化来自模型、Prompt，还是论文上下文变化。

------

# 15. Papers2Innovations 工作流

Papers2Innovations 不能只写成一个大 Prompt。

## 15.1 阶段一：Research Card

每篇论文提取：

```text
研究问题
背景假设
核心方法
方法模块
关键公式
训练目标
数据集
Baseline
主要结果
消融结果
失败案例
贡献声明
限制
Future Work
```

每条内容必须绑定：

```text
paper_id
section_id
page
source_text
confidence
```

## 15.2 阶段二：比较矩阵

统一比较：

```text
问题定义
核心假设
方法机制
输入输出
训练目标
数据集
评价指标
参数量
计算量
实验设置
主要结论
局限性
```

实验设置不一致时，不允许直接比较结果数字。

## 15.3 阶段三：创新候选

创新候选来源：

```text
论文 A 的方法是否能解决论文 B 的明确限制
两个研究分支之间是否缺少连接
多篇论文是否共享未经验证的假设
不同论文是否得到冲突结论
是否缺少关键数据、场景或评价指标
某个组件是否在消融中表现脆弱
性能提升是否依赖不可接受的成本
现有评测是否无法衡量目标能力
```

## 15.4 阶段四：新颖性搜索

为每个创新候选生成多组检索式：

```text
方法 A + 问题 B
方法别名 + 场景别名
数据集 + 方法组合
可能的论文标题
相邻引用图节点
```

系统不能说：

> 这是全新的顶会创新点。

只能说：

> 在当前论文库以及本次检索范围内，尚未发现高度相似的公开工作。

## 15.5 阶段五：Critic Agent

Critic 必须检查：

```text
是否只是简单模块拼接
是否已有同义工作
是否有更多参数或算力混淆
是否可以证伪
实验是否能验证核心假设
是否依赖不可获得的数据
是否有足够贡献形成完整论文
```

Critic 可以：

```text
通过
要求修改
降级为工程改进
拒绝
```

## 15.6 阶段六：实验卡

最终输出：

```text
创新假设
证据链
来源论文
最近似工作
关键差异
可证伪假设
最小实现
Baseline
数据集
评价指标
主实验
消融实验
控制变量
计算资源估计
预期结果
失败判据
潜在风险
新颖性置信度
技术可行性
论文完整度
```

## 15.7 创新排序

```text
总分 =
25% 新颖性
20% 证据充分性
20% 潜在意义
15% 实验可行性
10% 可证伪性
10% 论文完整度
```

分数只是筛选工具，不能作为“能中顶会”的保证。

------

# 16. 核心数据库表

```text
papers
paper_files
parse_runs
sections
figures
tables
authors
paper_authors
venues
venue_aliases
tags
paper_tags
collections
collection_papers
references
citation_mentions
citation_edges
research_cards
provider_profiles
model_profiles
agent_profiles
conversations
context_snapshots
context_items
agent_runs
tool_calls
innovation_cards
experiment_cards
jobs
```

关键原则：

- PDF、解析结果和 AI 结果分开
- AI 输出必须有版本
- 用户修改内容不能被重新生成覆盖
- 每次 Agent 运行可追溯
- 每条科研判断尽量绑定原文证据

------

# 17. 仓库结构

```text
papers2innovations/
├── apps/
│   └── desktop/
│       ├── src/
│       ├── src-tauri/
│       └── tests/
│
├── services/
│   └── paper-engine/
│       ├── p2i_engine/
│       │   ├── rpc/
│       │   ├── ingestion/
│       │   ├── parsing/
│       │   ├── metadata/
│       │   ├── citations/
│       │   ├── retrieval/
│       │   ├── agents/
│       │   ├── context/
│       │   ├── figures/
│       │   └── innovations/
│       └── tests/
│
├── packages/
│   ├── contracts/
│   ├── prompts/
│   ├── ccf-directory/
│   └── eval-datasets/
│
├── fixtures/
│   └── papers/
│
├── evals/
│   ├── parsing/
│   ├── metadata/
│   ├── citations/
│   ├── grounding/
│   ├── context/
│   └── innovations/
│
├── docs/
└── .github/workflows/
```

------

# 18. 16 周开发排期

## 第 1 周：工程骨架

完成：

- 创建 monorepo
- 初始化 Tauri + React
- 初始化 Python 项目
- SQLite migration
- 双向 JSON-RPC
- Tauri 启动 Python sidecar
- Windows/macOS/Linux CI
- 收集 30 篇测试论文

验收：

```text
桌面端可以启动 Python Engine
ping/pong 成功
Python 崩溃后可以重新启动
SQLite 可以升级
三个操作系统完成基础构建
```

## 第 2 周：本地论文库和文件监听

完成：

- 选择论文库目录
- 监听 Papers/
- SHA-256
- 去重
- 文件事件队列
- 重命名、移动和删除处理
- Jobs 页面
- 任务进度

验收：

```text
把 PDF 复制进目录后应用自动发现
同一 PDF 不重复解析
重命名不重新解析
删除后只标记 Missing
重启应用后任务状态保留
```

## 第 3 周：Docling 基础解析

完成：

- Docling adapter
- Markdown
- Docling JSON
- 章节结构
- 基础公式和表格
- 解析错误报告
- 模型组件下载管理

验收：

```text
30 篇论文都能生成 Markdown 或明确失败原因
正文阅读顺序基本正确
应用关闭后生成结果仍存在
```

## 第 4 周：图片和表格

完成：

- 插图提取
- Caption 匹配
- 表格导出
- Markdown 相对图片路径
- 图片缩略图
- 图片全屏
- 图片页码和 bbox

验收：

```text
普通论文插图提取成功率达到 90%
Markdown 图片可正常显示
图片能跳回 PDF 对应页面
```

## 第 5 周：GROBID 和引用解析

完成：

- GROBID 服务管理
- TEI 解析
- 作者、标题、摘要
- 参考文献
- 文内引用
- PDF 坐标
- GROBID 失败降级

验收：

```text
参考文献列表可显示
点击文内引用可查看参考条目
引用上下文能返回正文位置
```

第一版推荐将轻量 GROBID 作为可下载解析组件，而不是塞进基础安装包。

## 第 6 周：元数据补全和引用导出

完成：

- Crossref adapter
- OpenAlex adapter
- 标题模糊匹配
- 元数据冲突合并
- CSL-JSON
- BibTeX/BibLaTeX/RIS
- Citation Key

验收：

```text
有 DOI 的论文可自动补全
元数据冲突会要求用户确认
BibTeX 可直接用于 LaTeX
```

## 第 7 周：论文库 UI

完成：

- 论文列表
- 集合
- 标签
- 主题
- CCF
- 筛选
- 排序
- FTS5 搜索
- 批量操作

验收：

```text
能按标题、作者、会议、年份、CCF、主题筛选
1,000 篇模拟数据下列表操作流畅
```

## 第 8 周：PDF/Markdown 阅读器

完成：

- PDF.js
- Markdown 阅读
- 双栏模式
- 目录
- 段落锚点
- PDF/Markdown 联动
- 划词工具栏
- 笔记

验收：

```text
Markdown 段落可以定位 PDF
PDF 页码可以关联 Markdown 章节
选中文字可以加入上下文
```

## 第 9 周：Provider 和密钥系统

完成：

- ProviderProfile
- ModelProfile
- Stronghold
- Rust Model Gateway
- OpenAI Responses
- OpenAI-compatible
- 流式响应
- 请求取消
- API 测试页面

验收：

```text
两个 Agent 可使用不同密钥
两个 Agent 可使用不同 Base URL
密钥不出现在 SQLite、日志和前端状态
流式请求可以立即取消
```

## 第 10 周：Agent Runtime

完成：

- AgentProfile
- Tool Registry
- 工具权限
- 确认弹窗
- Agent Run 记录
- Tool Call 记录
- Prompt 版本
- Orchestrator

验收：

```text
Agent 能搜索和读取论文
写操作需要确认
禁止工具不会被 Agent 调用
每次运行可以查看完整执行摘要
```

## 第 11 周：上下文管理

完成：

- Context Tray
- 全文模式
- 结构化模式
- 检索模式
- Token 计数
- 容量条
- 输出预留
- 安全缓冲
- 超限处理
- Context Snapshot

验收：

```text
每个 Agent 可设置不同最大上下文
切换 Agent 后容量条重新计算
超限请求无法直接发送
所有 Agent 结果绑定 Context Snapshot
```

## 第 12 周：翻译和 Figure Agent

完成：

- DeepSeek 翻译
- 选中文本解释
- Figure Agent
- 图片重绘提示词
- 组件和关系
- Mermaid/Graphviz
- 不确定性标记

验收：

```text
翻译不会覆盖论文原文
图片分析结合 Caption 和上下文
无法识别的内容明确标记不确定
```

## 第 13 周：引用图谱

完成：

- 本地引用图
- OpenAlex 扩展
- References
- Citations
- Related works
- 相似度
- 聚类
- 图谱缓存

验收：

```text
任意种子论文可以生成局部图谱
真实引用与相似边明确区分
用户可以把图谱论文加入候选集合
```

## 第 14 周：Research Card 和多论文比较

完成：

- Research Card
- 证据抽取
- 比较矩阵
- 共同限制
- 冲突结论
- 方法和数据集实体
- 用户修正

验收：

```text
每条贡献和限制包含原文证据
3～10 篇论文可以生成比较矩阵
用户修改不会被后续生成覆盖
```

## 第 15 周：Papers2Innovations

完成：

- Innovation Generator
- Novelty Search
- Critic
- Experiment Designer
- 创新排序
- Innovation Card
- Markdown 导出
- 成本和 Token 报告

验收：

```text
每个候选至少包含两条论文证据
每个候选经过外部新颖性检索
每个候选包含可证伪假设
每个候选包含最小实验和失败判据
Critic 能拒绝低质量候选
```

## 第 16 周：稳定性和 Alpha 发布

完成：

- 数据备份与恢复
- 崩溃恢复
- 日志脱敏
- 数据库迁移
- 安装包
- 自动更新
- 许可证清单
- 端到端测试
- 用户文档

验收：

```text
Windows、macOS、Linux 均能安装
导入、关闭、重启后数据不丢失
API 密钥不会出现在日志
30 篇论文回归测试通过
完整 MVP 场景可以连续运行
```

------

# 19. 测试数据集

正式开发前准备至少 30 篇论文：

```text
单栏论文
双栏论文
扫描 PDF
大量公式
大量表格
复杂架构图
长参考文献
无 DOI
arXiv 版本
正式会议版本
不同 CCF 领域
中英文混排
```

人工标注其中 10 篇：

```text
标题
作者
年份
会议
DOI
章节顺序
图片数量
参考文献数量
主要贡献
主要限制
```

------

# 20. 第一版质量指标

## PDF 解析

```text
标题准确率              ≥ 95%
年份准确率              ≥ 95%
DOI准确率               ≥ 95%
普通插图提取成功率       ≥ 90%
参考文献分割召回率       ≥ 85%
章节顺序正确率           ≥ 90%
```

## AI 证据

抽查 100 条结果：

```text
证据支持结论            ≥ 90%
页码定位正确            ≥ 95%
无来源内容不伪装成原文   ≥ 98%
```

## 上下文

```text
OpenAI Token 计数准确    100% 使用官方接口
估算模型误差             ≤ 10%
超限拦截                 100%
Snapshot 记录完整        100%
```

## Papers2Innovations

人工 1～5 分：

```text
证据充分性
新颖性
可证伪性
实验可行性
非简单模块拼接
潜在研究价值
```

Alpha 发布要求：

```text
证据充分性平均 ≥ 4.0
可证伪性平均   ≥ 4.0
实验可行性平均 ≥ 3.5
```

------

# 21. 第一版最终验收场景

准备 5 篇同一研究方向论文：

1. 将 PDF 复制进本地 `Papers/`。
2. 应用自动发现并解析。
3. 生成带图片的 Markdown。
4. 自动补全作者、年份、会议和 DOI。
5. 解析参考文献和文内引用。
6. 导出可用 BibTeX。
7. 给 Translation Agent 配置 DeepSeek 密钥。
8. 给 Figure Agent 配置 GPT-5.6 和 `high` 推理强度。
9. 给 Innovation Agent 配置另一密钥和 256K 自定义上下文。
10. 选择 2 篇全文加载、3 篇结构化加载。
11. 容量条显示系统、工具、对话、论文、图片和输出预留。
12. 运行 Papers2Innovations。
13. 得到 1～3 张创新实验卡。
14. 每张卡都能跳回论文原文证据。
15. 每张卡包含最近似论文、关键差异、Baseline、数据集、指标、消融和失败判据。
16. 导出完整 Markdown 报告。

这个场景稳定跑通，即可发布第一版 Alpha。

------

# 22. 现在立即执行的第一周清单

第一天：

```text
建立 monorepo
创建产品需求文档
确定 PaperDocument Schema
确定 AgentProfile Schema
确定 ContextSnapshot Schema
```

第二天：

```text
初始化 Tauri + React
初始化 Python Paper Engine
实现 Rust 启动 sidecar
```

第三天：

```text
实现双向 JSON-RPC
实现 progress、result、error、cancel 消息
```

第四天：

```text
创建 SQLite migration
创建 papers、paper_files、jobs、parse_runs
```

第五天：

```text
实现论文库目录选择
实现文件监听
实现 SHA-256 和去重
```

第六天：

```text
接入 Docling
输出 paper.md 和 document.json
```

第七天完成首个垂直演示：

```text
把 PDF 复制进 Papers/
→ 应用自动发现
→ 显示解析进度
→ 生成 Markdown
→ 显示论文图片
→ 关闭应用
→ 重启后论文仍然存在
```

在这个垂直切片完成前，不开始 Agent、引用图谱或 Papers2Innovations。