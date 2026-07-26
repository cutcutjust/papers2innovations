# Papers2Innovations Alpha Product Requirements

## Goal

The first vertical slice must reliably turn PDFs placed in a local library into persistent Markdown documents with visible processing progress. A user can close and reopen the application without losing papers, jobs, or generated output.

## In scope

- Initialize the versioned library directory structure.
- Discover PDFs recursively below `Papers/` with a two-second stability window.
- Identify content by SHA-256, merge duplicate content, update paths after moves, and mark deleted files as missing.
- Persist papers, files, jobs, parse runs, sections, and figures in SQLite.
- Parse PDFs through an optional Docling adapter and a lightweight local fallback.
- Store `paper.md`, `document.json`, `metadata.json`, `references.json`, figure assets, parser name, and parser version.
- Exchange JSON-RPC 2.0 requests, results, errors, progress notifications, and cancellation over standard IO.
- Show the library, processing state, job history, Markdown, extracted figures, and source PDF in the desktop UI.

## Out of scope for this slice

Agent runtime, provider credentials, citation graph expansion, metadata enrichment, and the Papers2Innovations workflow are intentionally deferred until this slice passes its acceptance tests.

## Acceptance

1. Copy a PDF into `Papers/` and scan or watch the library.
2. The engine reports persisted progress and produces Markdown or a precise failure.
3. The same bytes at another path do not create a second paper.
4. Moving a PDF updates the file path without parsing the same bytes again.
5. Deleting a PDF marks its file and paper missing while retaining generated output.
6. Restarting the engine returns the same paper and job history from SQLite.

