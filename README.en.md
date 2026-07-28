<div align="center">
  <img src="apps/desktop/src-tauri/icons/128x128.png" width="88" alt="Papers2Innovations icon" />
  <h1>Papers2Innovations</h1>
  <p><strong>Built for Chinese-speaking researchers: understand English papers and turn grounded evidence into testable research ideas.</strong></p>
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

Papers2Innovations addresses two practical barriers: English terminology, equations, and long-form structure interrupt reading for Chinese speakers; newcomers may finish a paper yet still struggle to compare methods, locate gaps, and formulate a research question. It reconstructs PDFs as section-based Markdown linked to source pages, then keeps translation, explanation, evidence context, and innovation analysis in one recoverable local workspace.

> Current release: `v0.1.21` for Windows x64. The project remains in active `0.1.x` development; keep backups of irreplaceable source PDFs.

## Why Papers2Innovations exists

Saving PDFs or generating isolated summaries does not solve sustained understanding. Readers still face language friction, unverifiable paraphrases, and the harder task of finding shared assumptions, methodological differences, failure boundaries, and open questions across papers.

| Stage | What the system does | What the reader gains |
| --- | --- | --- |
| Organize | Import local/Zotero papers into a persistent folder tree; drag papers to group them. | A maintainable research library instead of scattered files. |
| Read | Rebuild section Markdown with PDF pages, figures, tables, and equations. | Clear paper structure with direct paths back to source pages. |
| Understand | Translate selections and explain equations or methods, with Chinese output by default. | Lower language friction without separating conclusions from evidence. |
| Accumulate | Add papers, sections, or paragraphs to shared context with anchors and token details. | Reusable research evidence rather than disposable chat history. |
| Innovate | Compare evidence, identify conflicts and gaps, then generate and critique ideas in stages. | A path from reading papers to testable questions and experiment plans. |

The system does not claim to replace research judgment. It makes sources, limitations, and intermediate reasoning inspectable so language assistance and idea exploration use the same evidence base.

## Capabilities

| Area | Capability |
| --- | --- |
| Library | Watch `Papers/`, import Zotero read-only, deduplicate by SHA-256, and organize papers in a persistent nested tree with drag-to-group. |
| Parse | Generate section Markdown, page anchors, figures, tables, and normalized coordinates; resume interrupted jobs by stage. |
| Read | Navigate Markdown/PDF by section or enter fullscreen focus mode with only outline, Markdown body, and paper assistant visible. |
| Context | Share evidence-bound context across Reader and Innovate, with expandable system prompts, paper text, and token budgets. |
| Prompt library | Organize templates for Reader chat, translation, explanation, Markdown cleanup, and Innovate; select them directly in each workspace. |
| Innovate | Run context compression, evidence extraction, idea generation, novelty review, and experiment critique. |
| Maintain | Receive signed GitHub update prompts or check manually from Settings without losing local configuration. |

## Models, security, and application

![Papers2Innovations model settings](docs/images/model-settings.png)

- API format is either **OpenAI-compatible** or **Anthropic-compatible**. The `Base URL` is always user-defined.
- Context presets are `128K`, `256K`, and `1M`, plus a custom integer from `4,096` to `2,000,000`.
- Models can be assigned to chat, Markdown cleanup, or full-page OCR without duplicating credentials.
- API keys are encrypted in Tauri Stronghold, whose vault password is protected by the operating-system keychain. Python, SQLite, and logs cannot read keys.
- Model registry, context limits, workflow assignments, OCR consent, typography, and library path are backed up as a non-secret Stronghold snapshot.
- **In-app updates and installer upgrades preserve existing settings and API keys.** Credentials are removed only when the user explicitly deletes them.
- Settings are split into **Models & Processing** and **Security & Application**, separating model workflows from updates, typography, privacy, and uninstall controls.
- **Answer output reserve** is generation capacity, not input text. The Context workspace distinguishes configured budgets from current serialized-text estimates.

## Research workspaces

### Collection tree

Collections are persistent library data, not decorative tags. Create nested folders, rename or delete nodes, filter an entire subtree, and drag a paper from the table to move it. Existing Zotero collections migrate beneath a `Zotero` root during upgrade.

![Papers2Innovations collection tree and drag-to-group](docs/images/collection-tree.png)

### Distraction-free reading

Focus mode hides global navigation, the library sidebar, toolbar, and context footer. Only the resizable section outline, structured Markdown, and paper assistant remain. Press `Esc` to restore the standard workspace.

![Papers2Innovations focus reading mode](docs/images/focus-reading.png)

### Prompt library

Templates support create, edit, recategorize, and delete workflows. Reader chat, translation, explanation, Markdown cleanup, and Innovate remember their selected template, while upgrades preserve legacy custom prompts.

### Evidence to experiments

The innovation workbench binds each run to an exact context snapshot. Stages may use different models, completed checkpoints persist, and retries resume from the interrupted stage.

![Papers2Innovations innovation pipeline](docs/images/innovation-pipeline.png)

## Quick start

1. Download the latest Windows installer from [GitHub Releases](https://github.com/cutcutjust/papers2innovations/releases/latest).
2. Open the app and select an independent library directory such as `E:\Papers2Innovations-Library`.
3. Place PDFs in `Papers/`, or close Zotero and use **Import Zotero**.
4. Track hashing, layout, OCR, image, table, and indexing stages in **Activity**; failed stages can be retried.
5. Create nested collections and drag papers into the research-topic tree.
6. In **Models & Processing**, add a model with a custom Base URL, context size, and API key, then assign Markdown/OCR workflows.
7. Read by section or enter Focus mode, choose templates for reading, translation, explanation, or cleanup, then continue in Innovate.

Local ingestion and fallback parsing do not require a model key. Translation, explanation, Markdown cleanup, OCR, Reader chat, and synthesis use only models configured by the user.

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

The app checks the signed GitHub `latest.json` after startup. A new version can be downloaded, installed, and relaunched in place; **Check for updates** is also available under Security & Application. GitHub availability never blocks local work.

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
