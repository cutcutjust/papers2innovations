# Papers2Innovations AI 交接文档

更新时间：2026-07-27
工作目录：`E:\Project_papers2innovations`
目标平台：Windows 桌面应用（Tauri 2），Web/Vite 仅用于前端快速预览。

## 0. 最新状态（2026-07-27，以本节为准）

- 公开仓库：`cutcutjust/papers2innovations`；开发分支：`codex/native-import-release`；Draft PR：`#1`。
- P0 已完成：OpenAI-compatible / Anthropic Provider、Stronghold 凭证、Rust 安全流式网关、取消、超时、usage 和错误脱敏。
- Reader 已读取真实 `document.json`；段落翻译支持流式、取消、重试、revisioned SQLite 保存和重启恢复。
- `0004_context_draft.sql` 已实现 Reader / Context / Agents / Innovate 共用的持久化 Context draft。
- `0005_context_compressions.sql` 已实现 AI Context 压缩、精确 active revision、模型与 Prompt 版本缓存、source hash 失效保护、token/耗时 usage，以及原文/压缩模式切换。
- P2 已完成：真实两层 Citation Graph、结构化引用提取、本地论文解析、环路与重复引用合并、关系分析、`.p2i` fingerprint 缓存，以及 Cytoscape.js 交互画布。
- 当前验证：Python `33 passed`、Vitest `10 passed`、TypeScript、Vite production build、Rust fmt/check/clippy 和 `7 passed`；Playwright 覆盖 1440×900、1100×760、720×600，控制台 0 error。
- 本机安装目录：`E:\Project_papers2innovations\install`；真实论文库：`E:\Papers2Innovations-Library`。
- 下一优先级：P3 Agent Runtime 与 Innovate Pipeline。下文中与本节冲突的“尚未实现”描述属于旧状态。

## 给下一位 AI 的启动提示词

```text
请先完整阅读 E:\Project_papers2innovations\AI-HANDOFF.md，然后检查 git status 和当前代码。
继续实现 Papers2Innovations 的真实功能，并保持现有 Figma Version 10 桌面界面。
不要使用 Figma AI，不要重做已经完成的页面，不要回滚当前工作树中的用户改动。
先从交接文档 P0 的通用 Provider、Stronghold 凭证和流式模型网关开始，完成后接通 Reader 的真实段落翻译与持久化。
实现必须同时覆盖 contracts、Rust/Tauri bridge、必要的 Python/SQLite 层、React UI、浏览器 fallback 和测试。
完成前运行文档中的验证命令，并使用 Playwright 检查 Windows 桌面尺寸下的视觉状态。
```

## 1. 当前任务目标

继续把 Papers2Innovations 实现为本地优先的 Windows 论文研究工作台，并保持现有 Figma Version 10 桌面界面的视觉风格。

下一阶段的重点不是继续堆静态页面，而是把已经完成的 Library、Reader、Context、Graph、Agents、Innovate 界面连接到真实论文数据、模型接口和持久化层。

用户已经明确提出以下产品要求：

1. 所有通用 AI 模型都是用户自定义接口，只支持两类协议：OpenAI-compatible 或 Anthropic。
2. 每一个 AI 处理环节都可以单独选择模型，默认值可以不同，模型统一在 Settings 中维护。
3. Reader 是核心页面。正文中间区域保持单列，不要拆成中英双栏。
4. Reader 中每个自然段是小卡片，每个章节（摘要、引言、方法等）是包含段落卡片的大卡片。
5. 段落支持翻译、保存译文、重新翻译、选词翻译、AI 解释公式、AI 解释定理。
6. Markdown、表格和数学公式必须正确渲染。
7. 用户可以把全文或选定章节加入对话 Context，并实时显示 Context 占用百分比。
8. Graph 从论文 A 出发，解析 A 的引用，再解析这些引用的引用，只到第二层；分析 A 的直接引用之间的关系；连接越多的论文节点越大。
9. Innovate 页面直接显示可编辑提示词；每篇论文可选择原文或 AI 压缩后加入 Context；每个处理阶段可以选择不同模型。
10. 产品最终是 Windows 桌面应用，不是只能运行在 Web 中的网页。

## 2. Figma 参考来源

线上 Figma Make：

`https://www.figma.com/make/a20XkFc3WLd47xfjHKjb5T/Papers2Innovations-Product-Design`

这个 Make 项目没有可用于 `get_design_context` 的 `node-id`。之前已经通过登录态下载 Version 10 源码，禁止再次调用 Figma AI 生成页面。

本地参考源码：

- `output/figma-version10-source/src/App.tsx`
- `output/figma-version10-source/src/components/shared.tsx`
- `output/figma-version10-source/src_pages_CitationGraph.tsx`
- `output/figma-version10-source/src_pages_InnovationWorkspace.tsx`
- `output/figma-version10-source/src/index.css`
- 原始压缩包：`Papers2Innovations Product Design.zip`

这些文件只作为视觉与交互参考，不要把 Figma Make 的静态数据直接复制成生产数据层。

## 3. 当前技术栈与数据流

```text
React 19 + TypeScript + Vite
        |
        | @tauri-apps/api invoke
        v
Tauri 2 / Rust gateway (apps/desktop/src-tauri/src/lib.rs)
        |
        | JSON-RPC 2.0 over stdio
        v
Python paper engine (services/paper-engine/p2i_engine)
        |
        +-- SQLite persistent library
        +-- PDF discovery / hashing / parsing / OCR / figures
        +-- paper.md / document.json / metadata.json / references.json
```

前端主要依赖：

- React Query：论文列表、任务列表、引擎状态刷新。
- Zustand：当前 View、选中论文、搜索、筛选、自定义模型注册表。
- React Markdown + remark-math + rehype-katex：Markdown、GFM 和公式渲染。
- Lucide React：界面图标。
- Tauri Stronghold：OCR 密钥加密保存。

浏览器预览时 `nativeRuntime === false`，`apps/desktop/src/lib/bridge.ts` 会返回 `apps/desktop/src/demo.ts` 中的演示数据。不要根据浏览器演示状态判断原生 RPC 已实现。

## 4. 当前页面到代码的映射

| 页面/能力 | 主要文件 | 当前状态 |
| --- | --- | --- |
| 应用路由与数据查询 | `apps/desktop/src/App.tsx` | 已连接真实论文列表、扫描、任务和本地 watcher |
| 全局顶栏 | `apps/desktop/src/components/Topbar.tsx` | 已迁移 Figma 风格 |
| 研究侧栏 | `apps/desktop/src/components/Sidebar.tsx` | 已迁移，集合与 Agent 数量部分仍为展示数据 |
| Library | `apps/desktop/src/components/LibraryWorkspace.tsx` | 论文表格、搜索、选择、扫描、打开 Reader 使用真实 `LibraryPaper` |
| Reader | `apps/desktop/src/components/Reader.tsx` | Markdown/PDF/图片真实；翻译、解释、Context 操作仍是前端状态 |
| Agents | `apps/desktop/src/components/Agents.tsx` | 界面完成，Agent 配置与运行是假数据 |
| Context | `apps/desktop/src/components/ContextWorkspace.tsx` | 原文/压缩模式和 token UI 完成，未持久化、未真正压缩 |
| Citation Graph | `apps/desktop/src/components/CitationGraph.tsx` | 真实两层图、引用关系、缓存、重分析、Context 与 Reader 操作已接通 |
| Innovate | `apps/desktop/src/components/InnovationWorkspace.tsx` | 提示词与模型路由 UI 完成；Run 仍是定时器模拟 |
| Settings | `apps/desktop/src/components/Settings.tsx` | 自定义模型注册表可用；模型 API Key 尚未实现；OCR Stronghold 已真实实现 |
| Activity | `apps/desktop/src/components/Activity.tsx` | 使用真实任务 RPC |
| Zotero Import | `apps/desktop/src/components/ZoteroImport.tsx` | 使用真实 Zotero RPC |
| 全局状态 | `apps/desktop/src/store.ts` | View、选择、模型注册表；部分状态在 localStorage |
| 前端桥接 | `apps/desktop/src/lib/bridge.ts` | 真实 Tauri RPC + 浏览器演示 fallback |
| OCR 凭证 | `apps/desktop/src/lib/credentials.ts` | Stronghold + OS credential store 已实现 |
| 视觉样式 | `apps/desktop/src/styles.css` | 文件后半部分是 Figma Version 10 覆盖层；旧样式仍被 Activity/Import/Settings 使用 |

旧的 `PaperList.tsx` 和 `Inspector.tsx` 目前不再由 `App.tsx` 使用。删除前先确认没有测试或未来复用需求。

## 5. 已经真实工作的能力

以下功能不能在后续重构中破坏：

- 选择和初始化论文库目录。
- 自动创建和管理 `Papers/`、`.p2i/` 目录结构。
- PDF 扫描、稳定性检查、SHA-256 去重、文件移动和缺失状态。
- 持久化解析任务、进度通知、取消与重试。
- Markdown、PDF 和抽取图片读取。
- KaTeX 数学公式渲染。
- Zotero 检查、预览和导入。
- Qwen OCR、用户上传许可、Stronghold 加密和连接测试。
- Tauri updater、Windows 安装/卸载、Python sidecar。

Python RPC 当前支持：

- `library.initialize`
- `library.scan`
- `library.list`
- `library.file_events`
- `job.list`
- `job.cancel`
- `job.retry`
- `paper.reparse`
- `paper.read_markdown`
- `paper.read_document`
- `paper.read_references`
- `graph.build`
- `zotero.inspect`
- `zotero.preview_import`
- `zotero.import`
- `component.status`

## 6. 当前仍是演示或临时实现的部分

### Reader

- 中文译文是固定说明文本，不是模型输出。
- “Save Translation”只保存在 React state，切换页面后丢失。
- 公式/定理解释是固定卡片内容。
- Agent 聊天输入没有提交逻辑。
- 全文 Context 的 46.1K/99.8K token 是固定估算。
- “Add Section”“Add”按钮没有真正写入 Context。

### Context

- Context 列表使用当前论文列表，但选择、模式和压缩模型没有持久化。
- token 数量是前端估算，不来自 tokenizer。
- AI compressed 没有生成或缓存压缩结果。
- Clear、Add papers、Filter sources 还未接行为。

### Graph（已完成）

- 解析流程写入结构化 `references.json`，并可修复旧的空引用产物。
- `graph.build` 强制最大深度为 2，处理环、重复引用、共享引用、共同作者、互引和主题相似关系。
- 图结果按本地论文库 fingerprint 缓存在 `.p2i/cache/graphs/`；强制重分析会绕过缓存。
- UI 使用动态加载的 Cytoscape.js，节点大小来自图内 degree，并接通 Reader、Context 和引用检查操作。

### Agents / Innovate

- Agent profile 是静态数组，没有 CRUD、执行器、工具权限或运行记录。
- Innovate 的 `Run synthesis` 是定时器模拟，没有真正调用模型。
- 提示词只保存在 `localStorage`。
- 阶段模型选择和 Context 模式主要是组件内 state，刷新会丢失。

### Settings / 模型

- `CustomModelConfig` 只有 `name/model/baseUrl/format`，没有 credential ID、headers、timeout 等。
- 模型定义存在 `localStorage`，模型密钥不能放在 localStorage。
- OCR 的 Stronghold 流程只能作为模式参考，不要把通用模型密钥混入 OCR 配置。

## 7. 建议的下一阶段优先级

### P0：通用模型与安全凭证

1. 扩展 contracts，区分 `ProviderConfig`、`ModelConfig`、`CredentialSummary`。
2. Provider 至少支持 `openai` 与 `anthropic` 两种协议。
3. API Key 使用独立 Stronghold key 保存，例如 `model-provider:<providerId>`；前端只能读 configured 状态，不能读回明文。
4. 在 Rust 层实现受控 HTTP gateway，避免 API Key 进入 Python stdio 日志或 React state 持久化。
5. 实现连接测试、超时、取消、错误映射和流式事件。
6. 不要在客户端硬编码官方 OpenAI/Anthropic 域名；Base URL 必须可自定义。

建议的最小接口：

```ts
type ApiFormat = "openai" | "anthropic";

interface ProviderConfig {
  id: string;
  name: string;
  format: ApiFormat;
  baseUrl: string;
  credentialId: string;
  headers?: Record<string, string>;
}

interface ModelConfig {
  id: string;
  providerId: string;
  model: string;
  displayName: string;
  maxContextTokens: number;
  maxOutputTokens: number;
}
```

### P1：Reader 真实翻译、解释与 Context

1. 从 `document.json` 读取 section/block/page/anchor，而不是只通过 Markdown 空行推断段落。
2. 为翻译结果建立持久化模型：paper、section、block、source hash、language、model、prompt version、revision、createdAt。
3. 翻译和解释必须流式更新，并提供 loading、cancel、retry、error、saved 状态。
4. 公式解释传入原始 LaTeX 和相邻段落；定理解释传入 statement、proof 与 source anchor。
5. 选词翻译应定位 selection range，不要只有选中文本字符串。
6. Context 操作统一写入一个全局 `ContextSnapshot`/draft，而不是 Reader 与 Context 各自维护状态。
7. 使用模型 tokenizer 或可靠近似值计算实时 Context，占用必须包含 system/tools/conversation/papers/output reserve/safety buffer。

### P2：真实两层 Citation Graph（已完成）

1. 让解析器写入结构化 `references.json`，至少包含 title、authors、year、venue、doi/arXiv、raw citation、resolved ID。
2. 新增 `paper.read_document`、`paper.read_references`、`graph.build` RPC。
3. `graph.build(rootPaperId, maxDepth=2)` 必须强制深度上限为 2。
4. 直接引用之间的关系至少包括共享引用、互相引用、共同作者、主题相似度，并明确 relation type。
5. 节点大小基于图内 degree，不要用全网 citation count 冒充本地连接数。
6. 图布局可使用成熟库（例如 Cytoscape.js 或 Sigma.js）；不要长期维护手写百分比坐标。
7. 图构建应缓存到 `.p2i/`，并展示 parsing/resolving/ready/partial/error 状态。

### P3：Agent Runtime 与 Innovate Pipeline

1. 持久化 Agent profile、允许工具、网络策略、写入策略和默认模型。
2. 创建统一运行记录：input context snapshot、prompt version、stage model、tool calls、token usage、cost、output、error。
3. Innovate 五个阶段按界面路由：compression、evidence、ideas、novelty、critique。
4. 每个阶段都必须能取消、重试、切换模型并保留证据引用。
5. 输出研究想法时，事实性声明必须附 paper/section/page/block anchor。

## 8. 桌面端视觉与交互约束

必须继续遵循当前 Figma Version 10 视觉语言：

- Windows 默认窗口：1440×900，最小 720×600，配置在 `apps/desktop/src-tauri/tauri.conf.json`。
- 40px 全局顶栏，232px 研究侧栏。
- 主色 `#4F6BED`，AI 色 `#7357D8`，成功色 `#28A06A`。
- 工作区背景 `#F7F8FA`，面板 `#FFFFFF`，分隔线 `#E2E5EA`。
- 卡片圆角通常 4-6px，不要改成大圆角营销卡片。
- 信息密度高、工具型、桌面优先；不要新增 Hero、渐变球、装饰插画或大面积单色背景。
- 按钮优先使用 Lucide 图标；固定工具使用图标按钮并提供 title/tooltip。
- Reader 正文保持单列。左右可以有 Outline 与 Agent 面板，但正文内部不能拆为双栏翻译视图。
- Graph 保持左列表、中画布、右详情的三栏桌面结构；窄屏可以隐藏辅助栏。
- 不允许文本、按钮、图节点或底部导航互相遮挡。
- 不要移除 700px 响应式样式，尽管桌面端是主要目标。

当前 CSS 中旧样式与 Figma 覆盖层共存。可以逐步拆成模块，但必须在一次独立重构中完成并进行全页面截图，不要边实现后端边大规模重写 CSS。

## 9. 推荐的状态与持久化边界

- React Query：来自引擎/RPC 的 server state，包括 papers、jobs、documents、references、runs。
- Zustand：当前选中项、正在编辑的 Context draft、当前页面和短期 UI state。
- SQLite / `.p2i/`：论文结构、翻译、解释、Context snapshots、Graph cache、Agent runs。
- localStorage：只保留无安全风险的轻量 UI 偏好；不要存 API Key、完整论文内容或运行结果。
- Stronghold：所有 provider credentials。

不要为每个页面分别建立一套 Context state。Reader、Context、Agents、Innovate 必须消费同一个 Context draft，并通过选择器减少无关重渲染。

## 10. 开发与验证命令

安装与 Web 预览：

```powershell
cd E:\Project_papers2innovations
npm install
npm run dev
```

预览地址：`http://127.0.0.1:1420`

原生桌面开发：

```powershell
npm run tauri dev --workspace @p2i/desktop
```

如果 Tauri 找不到 sidecar，先执行：

```powershell
.\scripts\build-sidecar.ps1
```

前端验证：

```powershell
npm run typecheck
npm test
npm run build
```

完整验证：

```powershell
python -m pytest services/paper-engine/tests
cd apps/desktop/src-tauri
cargo fmt --check
cargo check
cargo clippy -- -D warnings
cargo test
```

上一轮已通过：desktop TypeScript、4 项 Vitest、Vite production build、1440×960 与 700×900 Playwright 检查，浏览器控制台 0 error。

视觉回归截图位于：

- `output/playwright/library-1440.png`
- `output/playwright/reader-1440.png`
- `output/playwright/graph-1440.png`
- `output/playwright/agents-1440.png`
- `output/playwright/context-1440.png`
- `output/playwright/innovate-1440.png`
- `output/playwright/settings-1440.png`
- `output/playwright/library-700.png`
- `output/playwright/reader-700-translation.png`

## 11. 每次功能实现的验收要求

1. 先确认是在 Web demo 还是 Tauri native 下验证。
2. 新增 RPC 时同步更新 Python、Rust bridge、TypeScript contracts、浏览器 fallback 和测试。
3. 所有异步 AI 操作必须有 loading、cancel、retry、error 和 persisted/unsaved 状态。
4. 不允许用 `setTimeout` 模拟完成后声称功能已实现。
5. API Key 不得出现在 localStorage、日志、JSON-RPC 参数、截图或 Git diff 中。
6. Reader 的保存结果在应用重启后仍应存在。
7. Graph 必须证明最大深度是 2，并针对环、重复引用、无法解析 DOI、部分失败添加测试。
8. Context 百分比必须由同一个 token breakdown 计算，Reader、Context、Innovate 显示一致。
9. 每次 UI 改动至少检查 1440×900、1100×760、720×600。
10. 完成前运行类型检查、相关测试、production build 和 Playwright 截图，并检查 console error。

## 12. 工作区与 Git 注意事项

当前工作树是脏的，包含本轮界面迁移、之前的 Tauri/sidecar/OCR/发布脚本改动，以及尚未提交的新组件。

不要执行：

- `git reset --hard`
- `git checkout -- .`
- 删除或覆盖与当前任务无关的修改
- 把 `output/figma-version10-source` 当成生产源码导入应用
- 在没有确认归属前批量格式化整个仓库

开始工作前先执行：

```powershell
git status --short
git diff -- apps/desktop/src
```

本轮主要新增文件：

- `apps/desktop/src/components/LibraryWorkspace.tsx`
- `apps/desktop/src/components/Agents.tsx`
- `apps/desktop/src/components/ContextWorkspace.tsx`
- `apps/desktop/src/components/CitationGraph.tsx`
- `apps/desktop/src/components/InnovationWorkspace.tsx`

## 13. 建议下一位 AI 的第一项实现

下一项是 P3 Agent Runtime 与 Innovate Pipeline，复用已完成的安全模型网关和共享 Context draft：

1. 新增 migration 和 RPC，持久化 Agent profile、工具/网络/写入策略和默认模型。
2. 建立统一 run/stage 记录，保存 input context snapshot、prompt revision、model、usage、output、error 与 evidence anchors。
3. 接通 Agent CRUD、运行、取消、重试和重启恢复，移除 Agents 页静态数组。
4. 让 Innovate 的 compression、evidence、ideas、novelty、critique 五阶段真实串行执行，每阶段可独立选模型、取消和重试。
5. 同步覆盖 contracts、Python/Rust bridge、React UI、浏览器 fallback、测试与三尺寸 Playwright 验收。
