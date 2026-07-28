<div align="center">
  <img src="apps/desktop/src-tauri/icons/128x128.png" width="88" alt="Papers2Innovations icon" />
  <h1>Papers2Innovations</h1>
  <p><strong>A local-first research workspace that turns PDFs into structured evidence, reusable context, and testable ideas.</strong></p>
  <p><a href="README.md">中文</a> · <a href="README.en.md">English</a></p>
  <p>
    <a href="https://github.com/cutcutjust/papers2innovations/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/cutcutjust/papers2innovations?style=flat-square&color=5865df" /></a>
    <img alt="Windows 10 and 11" src="https://img.shields.io/badge/Windows-10%20%7C%2011-0078d4?style=flat-square&logo=windows" />
    <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24c8db?style=flat-square&logo=tauri&logoColor=white" />
    <img alt="Local first" src="https://img.shields.io/badge/data-local--first-238636?style=flat-square" />
  </p>
  <p><a href="https://github.com/cutcutjust/papers2innovations/releases/latest"><strong>Download for Windows</strong></a></p>
</div>

![Section-based Papers2Innovations Reader](docs/images/reader-workspace.png)

Papers2Innovations keeps PDFs, structured Markdown, evidence anchors, model usage, and research runs in a recoverable local workspace. Its Tauri desktop host, Python parsing engine, and React UI provide Zotero import, section-based reading, figure extraction, context management, research agents, and staged innovation synthesis.

> Current release: `v0.1.14` for Windows x64. The project remains in active `0.1.x` development; keep backups of irreplaceable source PDFs.

## Capabilities

| Area | Capability |
| --- | --- |
| Ingest | Watch `Papers/`, preview and import Zotero read-only, deduplicate by SHA-256, copy atomically, and record provenance. |
| Parse | Generate section Markdown, page anchors, figures, tables, and normalized coordinates; resume interrupted jobs by stage. |
| Read | Navigate by paper section, render math, open source pages, and persist translation and explanation revisions. |
| Context | Share evidence-bound context across Reader, Agents, and Innovate with visible token usage and compression. |
| Agents | Configure a model, prompt, tool permissions, network/write policy, cancellation, retries, and checkpoints per agent. |
| Innovate | Run context compression, evidence extraction, idea generation, novelty review, and experiment critique. |
| Maintain | Receive signed GitHub update prompts or check manually from Settings without losing local configuration. |

## Models and security

![Papers2Innovations model settings](docs/images/model-settings.png)

- API format is either **OpenAI-compatible** or **Anthropic-compatible**. The `Base URL` is always user-defined.
- Context presets are `128K`, `256K`, and `1M`, plus a custom integer from `4,096` to `2,000,000`.
- Models can be assigned to chat, Markdown cleanup, or full-page OCR without duplicating credentials.
- API keys are encrypted in Tauri Stronghold, whose vault password is protected by the operating-system keychain. Python, SQLite, and logs cannot read keys.
- Model registry, context limits, workflow assignments, OCR consent, typography, and library path are backed up as a non-secret Stronghold snapshot.
- **In-app updates and installer upgrades preserve existing settings and API keys.** Credentials are removed only when the user explicitly deletes them.

## Research workspaces

### Agent Center

Agents execute only explicitly allowed local tools. Default prompts request Chinese output and require paper, section, block, or page anchors for factual claims; prompts remain fully editable.

![Papers2Innovations Agent Center](docs/images/agent-center.png)

### Evidence to experiments

The innovation workbench binds each run to an exact context snapshot. Stages may use different models, completed checkpoints persist, and retries resume from the interrupted stage.

![Papers2Innovations innovation pipeline](docs/images/innovation-pipeline.png)

## Quick start

1. Download the latest Windows installer from [GitHub Releases](https://github.com/cutcutjust/papers2innovations/releases/latest).
2. Open the app and select an independent library directory such as `E:\Papers2Innovations-Library`.
3. Place PDFs in `Papers/`, or close Zotero and use **Import Zotero**.
4. Track hashing, layout, OCR, image, table, and indexing stages in **Activity**; failed stages can be retried.
5. In **Settings**, add a model with a custom Base URL, context size, and API key, then assign Markdown/OCR workflows.
6. Read by section, add evidence to shared Context, and continue in Agents or Innovate.

Local ingestion and fallback parsing do not require a model key. Translation, explanation, Markdown cleanup, OCR, agents, and synthesis use only models configured by the user.

## Data boundaries

```text
Papers2Innovations-Library/
|-- Papers/                 # User-managed or Zotero-imported PDFs
|-- Exports/
`-- .p2i/
    |-- library.sqlite      # Jobs, sections, provenance, context, and runs
    |-- generated/          # Markdown, figures, tables, and thumbnails
    |-- cache/              # OCR pages and citation graph cache
    |-- components/
    `-- logs/
```

The paper library is independent of the application install directory. Upgrading or uninstalling Papers2Innovations does not delete it. Full-page OCR remains disabled until explicit consent, and cached pages are not charged again.

## Updates and uninstalling

The app checks the signed GitHub `latest.json` after startup. A new version can be downloaded, installed, and relaunched in place; **Check for updates** is also available in Model & Security settings. GitHub availability never blocks local work.

Uninstall through Windows Installed Apps, the Start menu shortcut, or Settings. The uninstaller removes app files while preserving the independent library and user data.

## Development

Prerequisites: Node.js 20+, Python 3.11, Rust stable with `rustfmt` and `clippy`, and Tauri 2 platform dependencies.

```powershell
git clone https://github.com/cutcutjust/papers2innovations.git
cd papers2innovations
npm install
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e "services/paper-engine[dev]"
.\scripts\build-sidecar.ps1
npm run tauri:dev --workspace @p2i/desktop
```

Quality gates:

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

The repository excludes PDFs, local manifests, libraries, Stronghold files, keys, component caches, and package outputs. Use [GitHub Issues](https://github.com/cutcutjust/papers2innovations/issues) for reproducible bugs and focused feature proposals.
