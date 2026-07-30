<div align="center">
  <img src="apps/desktop/src-tauri/icons/128x128.png" width="88" alt="Papers2Innovations icon" />
  <h1>Papers2Innovations</h1>
  <p><strong>Help Chinese-speaking readers understand English papers and turn grounded evidence into testable research ideas.</strong></p>
  <p><a href="README.md">中文</a> · <a href="README.en.md">English</a></p>
  <p>
    <a href="https://github.com/cutcutjust/papers2innovations/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/cutcutjust/papers2innovations?style=flat-square&color=5865df" /></a>
    <img alt="Windows 10 and 11" src="https://img.shields.io/badge/Windows-10%20%7C%2011-0078d4?style=flat-square&logo=windows" />
    <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24c8db?style=flat-square&logo=tauri&logoColor=white" />
    <img alt="Local first" src="https://img.shields.io/badge/data-local--first-238636?style=flat-square" />
  </p>
  <p><a href="https://github.com/cutcutjust/papers2innovations/releases/latest"><strong>Download for Windows</strong></a></p>
</div>

![Section-based Papers2Innovations Immersive Reader](docs/images/reader-workspace.png)

Papers2Innovations is not another “store PDFs and generate a summary” tool. It focuses on two harder problems: helping Chinese speakers cross the language, terminology, equation, and long-document barriers in English papers; and helping research newcomers move from understanding one paper to comparing many, locating a gap, and proposing a question that can be tested.

It reconstructs PDFs as section-based documents linked back to source pages, then brings bilingual reading, paper-scoped context, figure analysis, citation relationships, and staged innovation work into one recoverable local workspace.

> Current release: Windows x64 `v0.1.27`. The project is still evolving rapidly in `0.1.x`; keep backups of irreplaceable source PDFs.

## Highlights

| Research friction | What Papers2Innovations does | Result |
| --- | --- | --- |
| English prose is slow and terminology repeats | Chinese translations visually replace sentences in place while the English Markdown remains immutable; phrases and technical terms stay available nearby. | Continuous reading without losing the evidence location. |
| PDF structure, equations, figures, and tables are tangled | Docling-first parsing reconstructs sections, reading order, pages, tables, figures, and equations; interrupted stages resume. | Searchable, locatable, reusable paper structure. |
| AI answers drift away from the source | Each paper has an isolated persistent conversation and immutable context snapshots shared by selections, figures, and equations. | Questions remain grounded in the current paper. |
| Reading many papers still does not reveal a research gap | Innovate stages evidence extraction, comparison, idea generation, novelty review, and experiment critique. | A route from literature findings to testable questions and experiment drafts. |
| A growing library becomes hard to organize | Persistent folder trees support dragging papers and folders; Zotero is imported read-only with provenance. | A maintainable local research library. |

## Immersive Reading and bilingual overlays

- Reader navigation follows paper sections instead of mechanically splitting Markdown by PDF page; page anchors remain available for verification.
- Body text supports `80%`–`180%` zoom, `Ctrl + wheel`, white/warm/soft-green/dark themes, and custom accessible colors.
- Translated mode shows Chinese at the original English location while untranslated text stays English; Original mode restores the complete English paper.
- Translation and dialogue marks open phrases, terms, literal meaning, paper-specific meaning, or linked questions near the selected range.
- Translation, explanation, and chat live in independent rendering layers and never mutate the PDF or Markdown.
- LaTeX is rendered with KaTeX; extracted figures can expand cached AI explanations.

![Non-destructive bilingual reading in Papers2Innovations](docs/images/bilingual-reader.png)

Focus mode removes global navigation and keeps only the resizable section outline, document body, and paper assistant.

![Papers2Innovations focus reading mode](docs/images/focus-reading.png)

## From library to research workspace

### Persistent collection tree

Collections are data, not decorative tags. Nodes, hierarchy, and paper assignments persist in SQLite, parent counts include descendants, and both papers and folders can be dragged into a new group.

![Papers2Innovations collection tree and drag-to-group](docs/images/collection-tree.png)

### Read-only Zotero import

First launch guides users through creating a local library, assigning text and vision models, and adding local PDFs. Local import is always the primary path; Zotero is an optional source inside Add Papers. Zotero is discovered from its profile; if discovery fails, select the directory containing `zotero.sqlite`. Preview collections, papers, page estimates, and files before import. PDFs are SHA-256 verified and atomically copied while Zotero remains untouched.

![Papers2Innovations Zotero import wizard](docs/images/zotero-import.png)

### Citation relationship graph

The graph uses a stable concentric layout around the current paper, separating direct references, second-level evidence, local papers, and unresolved records. Search by title, author, or year; filter by depth or status; select a node to emphasize only its paths and inspect relation type, weight, and parse state.

![Papers2Innovations citation relationship graph](docs/images/citation-graph.png)

## Paper context and Innovate

- Every paper owns one persistent multi-turn reading conversation backed by its Markdown; over-budget documents can reuse a generated compression.
- Context management exposes serialized text and token budgets, supports editable custom items, and can restore the default full paper.
- Each answer stores an immutable send-time snapshot, so later context edits do not rewrite history.
- Innovate uses a separate multi-paper research context that never leaks into a paper conversation.
- The Prompt Library manages reusable templates for Reader chat, translation, explanation, Markdown cleanup, and Innovate.

![Papers2Innovations evidence-to-experiment pipeline](docs/images/innovation-pipeline.png)

## Models, credentials, and updates

![Papers2Innovations model and document-processing settings](docs/images/model-settings.png)

- API format is **OpenAI-compatible** or **Anthropic-compatible** and the `Base URL` is always user-defined.
- Context presets are `128K`, `256K`, and `1M`, plus custom integers from `4,096` to `2,000,000`.
- Chat, Markdown cleanup, full-page OCR, and figure analysis can use different models without duplicating keys.
- API keys are encrypted in Tauri Stronghold. Windows also stores an operating-system credential backup so keys recover after model-ID or settings migrations.
- Keys never enter Python, SQLite, logs, frontend persistent state, source files, or Git.
- Installer and in-app upgrades preserve the library, models, keys, prompts, typography, themes, context, and job state.
- New releases prompt on startup and can also be checked under Security & Application; signed updates install in place and relaunch.

## Quick start

1. Download the latest Windows x64 installer from [GitHub Releases](https://github.com/cutcutjust/papers2innovations/releases/latest).
2. Follow first-run setup to create the recommended library or select an independent existing directory.
3. Assign at least one text model and one vision model. A multimodal model may serve both roles, and setup can be deferred.
4. Use **Add Papers** to select or drop local PDFs; open the optional Zotero wizard from the same panel when needed.
5. Track hash, layout, OCR, image, table, and indexing stages under Activity; retry from a failed stage.
6. Read by section, translate and ask questions in Immersive Reading, then move selected evidence into Innovate for cross-paper work.

Local import and fallback parsing need no model key. Translation, explanation, Markdown cleanup, OCR, figure analysis, chat, and innovation workflows call only user-configured models.

## Data boundaries

```text
Papers2Innovations-Library/
|-- Papers/                 # Locally added or Zotero-imported PDFs
|-- Exports/
`-- .p2i/
    |-- library.sqlite      # Jobs, sections, provenance, context, and runs
    |-- generated/          # Markdown, figures, tables, and thumbnails
    |-- cache/              # OCR pages, figure analysis, and citation graphs
    |-- components/
    `-- logs/
```

The library is independent of the install directory. Updating or uninstalling the app does not delete it. Full-page OCR remains disabled until explicit consent, and cached pages are not submitted again.

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

The repository excludes PDFs, local manifests, paper libraries, Stronghold files, keys, component caches, and package outputs. Report reproducible bugs and focused feature requests in [GitHub Issues](https://github.com/cutcutjust/papers2innovations/issues).
