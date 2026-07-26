# Papers2Innovations

Papers2Innovations is a local-first desktop workspace that turns a folder of PDF papers into a persistent, searchable Markdown library. This repository implements the first vertical slice from `papers2innovations plan v1.md`.

## Development

Prerequisites: Node.js 20+, Python 3.11+, Rust stable with `rustfmt` and `clippy`, and the Tauri 2 platform prerequisites.

```powershell
npm install
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e "services/paper-engine[docling,dev]"
npm run dev
```

Run the paper engine directly:

```powershell
.\.venv\Scripts\python.exe -m p2i_engine rpc
.\.venv\Scripts\python.exe -m p2i_engine scan E:\Papers2Innovations-Library
.\.venv\Scripts\python.exe -m p2i_engine watch E:\Papers2Innovations-Library
```

The library layout is created on first use. Users manage only `Papers/`; generated assets and the SQLite database live under `.p2i/`.

Build the packaged Python sidecar before checking or bundling the native app because Tauri validates `externalBin` during its Rust build script:

```powershell
.\scripts\build-sidecar.ps1
npm run tauri build --workspace @p2i/desktop
```

Qwen credentials must be entered through the native **OCR & security** settings view. The API key is encrypted in Stronghold, the Stronghold password is generated automatically and held by the operating system credential store, and neither value belongs in environment files or repository configuration.

## Validation

```powershell
npm run typecheck
npm run build
python -m pytest services/paper-engine/tests
cd apps/desktop/src-tauri
cargo fmt --check
cargo check
cargo clippy -- -D warnings
cargo test
```
