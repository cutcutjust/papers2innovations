<div align="center">
  <img src="apps/desktop/src-tauri/icons/128x128.png" width="88" alt="Papers2Innovations 图标" />
  <h1>Papers2Innovations</h1>
  <p><strong>本地优先的论文研究工作台：把 PDF 变成结构化证据、可复用上下文与可验证的研究想法。</strong></p>
  <p><a href="README.md">中文</a> · <a href="README.en.md">English</a></p>
  <p>
    <a href="https://github.com/cutcutjust/papers2innovations/releases/latest"><img alt="最新版本" src="https://img.shields.io/github/v/release/cutcutjust/papers2innovations?style=flat-square&color=5865df" /></a>
    <img alt="Windows 10 和 11" src="https://img.shields.io/badge/Windows-10%20%7C%2011-0078d4?style=flat-square&logo=windows" />
    <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24c8db?style=flat-square&logo=tauri&logoColor=white" />
    <img alt="本地优先" src="https://img.shields.io/badge/data-local--first-238636?style=flat-square" />
  </p>
  <p><a href="https://github.com/cutcutjust/papers2innovations/releases/latest"><strong>下载 Windows 安装包</strong></a></p>
</div>

![按章节组织的 Papers2Innovations 阅读器](docs/images/reader-workspace.png)

Papers2Innovations 将 PDF、结构化 Markdown、证据锚点、模型调用和研究运行记录放在一个可恢复的本地工作区中。它由 Tauri 原生桌面端、Python 解析引擎与 React 界面组成，支持 Zotero 导入、章节阅读、图表提取、上下文管理、研究智能体和分阶段创新综合。

> 当前版本：Windows x64 `v0.1.15`。项目仍处于 `0.1.x` 快速迭代阶段，请保留不可替代源 PDF 的备份。

## 核心能力

| 模块 | 能力 |
| --- | --- |
| 导入 | 监听本地 `Papers/`，只读预览并导入 Zotero，SHA-256 去重，原子复制并记录来源。 |
| 解析 | 生成章节 Markdown、页码锚点、插图、表格和规范化坐标；中断任务可从失败阶段恢复。 |
| 阅读 | 按论文章节组织正文与 PDF 目录，点击章节跳转源页，可调目录宽度，并正确渲染 AI 返回的 LaTeX 公式。 |
| 上下文 | Reader、Agents 和 Innovate 共享绑定证据的上下文；显示 token 用量并支持压缩。 |
| 智能体 | 为每个研究智能体设置模型、提示词、工具权限、网络/写入策略、取消、重试和检查点。 |
| 创新 | 依次执行上下文压缩、证据提取、想法生成、创新性验证与实验批判。 |
| 更新 | 自动提示 GitHub 新版本，也可在设置页手动检查；签名更新完成后自动重启。 |

## 模型与安全

![Papers2Innovations 模型设置](docs/images/model-settings.png)

- 接口格式只分为 **OpenAI-compatible** 与 **Anthropic-compatible**，`Base URL` 始终由用户自定义。
- 模型上下文可选 `128K`、`256K`、`1M`，也可输入 `4,096` 到 `2,000,000` 的自定义整数。
- 每个模型可独立用于普通对话、Markdown 整理或全文 OCR；Markdown 整理会保留公式、引用、图片路径和证据锚点。
- API Key 加密保存在 Tauri Stronghold，保险库密码由系统钥匙串保护；Python、SQLite 和日志均无法读取密钥。
- 自定义模型、上下文限制、任务模型、OCR 授权、字号和论文库路径会同时保存在 WebView 设置与 Stronghold 非敏感快照中。
- **覆盖安装与应用内更新不会清空已有设置或密钥。** 只有用户明确删除模型/密钥时才会移除对应凭据。

## 研究工作区

### 智能体中心

智能体只使用显式允许的本地工具。系统提示词默认要求中文输出，并要求事实性结论引用论文、章节、文本块或页码锚点。

![Papers2Innovations 智能体中心](docs/images/agent-center.png)

### 从证据到实验

创新工作台把每次运行绑定到确定的上下文快照。各阶段可选择不同模型，已完成检查点会保留，失败后从中断阶段继续。

![Papers2Innovations 创新流水线](docs/images/innovation-pipeline.png)

## 快速开始

1. 从 [GitHub Releases](https://github.com/cutcutjust/papers2innovations/releases/latest) 下载最新 Windows 安装包。
2. 打开应用并选择论文库目录，推荐使用独立目录，如 `E:\Papers2Innovations-Library`。
3. 将 PDF 放入 `Papers/`，或关闭 Zotero 后使用“导入 Zotero”。
4. 在“任务活动”查看哈希、版面、OCR、图像、表格和索引进度；失败阶段可重试。
5. 在“设置”中添加模型、自定义 Base URL、上下文长度和 API Key，再分配 Markdown/OCR 模型。
6. 在阅读器中按章节阅读，将证据加入共享上下文，然后使用智能体或创新工作台。

本地导入与降级解析无需模型密钥。翻译、解释、Markdown 整理、OCR、智能体和综合功能才会调用用户配置的模型。

## 数据边界

```text
Papers2Innovations-Library/
|-- Papers/                 # 用户管理或从 Zotero 复制的 PDF
|-- Exports/
`-- .p2i/
    |-- library.sqlite      # 任务、章节、来源、上下文和运行记录
    |-- generated/          # Markdown、插图、表格和缩略图
    |-- cache/              # OCR 页面和引用图谱缓存
    |-- components/
    `-- logs/
```

论文库独立于应用安装目录。升级或卸载 Papers2Innovations 不会删除论文库。全文 OCR 默认关闭，只有用户明确授权后才会发送渲染页面，且已缓存页面不会重复计费调用。

## 更新与卸载

应用启动后会检查签名的 GitHub `latest.json`。发现新版本时可直接下载、安装并重启；也可在“模型与安全”页面点击“检查更新”。GitHub 暂时不可用时不会阻止本地功能。

卸载可通过 Windows“已安装的应用”、开始菜单卸载快捷方式，或“设置 > 应用管理”。卸载程序仅移除应用文件，保留论文库与用户数据。

## 本地开发

需要 Node.js 20+、Python 3.11、Rust stable（含 `rustfmt`、`clippy`）以及 Tauri 2 的 Windows 构建依赖。

```powershell
git clone https://github.com/cutcutjust/papers2innovations.git
cd papers2innovations
npm install
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e "services/paper-engine[dev]"
.\scripts\build-sidecar.ps1
npm run tauri:dev --workspace @p2i/desktop
```

质量门：

```powershell
npm run typecheck
npm test
npm run build
.\.venv\Scripts\python.exe -m pytest services/paper-engine/tests
cd apps/desktop/src-tauri
cargo fmt --check
cargo check
cargo clippy -- -D warnings
cargo test
```

仓库不会提交 PDF、本地 manifest、论文库、Stronghold 文件、密钥、组件缓存或打包生成物。问题和功能建议请提交到 [GitHub Issues](https://github.com/cutcutjust/papers2innovations/issues)。
