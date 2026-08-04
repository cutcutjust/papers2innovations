import type { LibraryPaper } from "@p2i/contracts";

export const demoPapers: LibraryPaper[] = [
  {
    id: "demo-graph-reasoning",
    title: "Evidence-Grounded Graph Reasoning for Scientific Discovery",
    sourcePath: "D:/Research/Papers/Graph-Reasoning/evidence-grounded.pdf",
    status: "READY",
    progress: 1,
    pageCount: 14,
    markdownPath: "demo/paper.md",
    documentPath: "demo/document.json",
    figures: [
      {
        id: "demo-figure-1",
        relativePath: "figures/pipeline.png",
        caption: "Figure 1. Evidence-aware retrieval and comparison pipeline.",
        page: 4,
        mimeType: "image/png",
      },
    ],
    collectionIds: ["demo-methods"],
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    updatedAt: new Date().toISOString(),
    isFavorite: true,
    favoritedAt: new Date(Date.now() - 3_600_000).toISOString(),
    lastOpenedAt: new Date(Date.now() - 900_000).toISOString(),
    lastReadAt: new Date(Date.now() - 900_000).toISOString(),
    lastSectionId: "method",
    lastPage: 4,
    readingProgress: 0.42,
  },
  {
    id: "demo-multimodal",
    title: "A Structured Benchmark for Multimodal Research Agents",
    sourcePath: "D:/Research/Papers/Agents/multimodal-benchmark.pdf",
    status: "PARSING_LAYOUT",
    progress: 0.46,
    pageCount: 0,
    figures: [],
    collectionIds: ["demo-multimodal-group"],
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    updatedAt: new Date(Date.now() - 3600_000).toISOString(),
    isFavorite: false,
    readingProgress: 0,
  },
  {
    id: "demo-failed",
    title: "Robust Table Extraction from Scanned Documents",
    sourcePath: "D:/Research/Papers/Document-AI/scanned-tables.pdf",
    status: "FAILED",
    progress: 1,
    pageCount: 0,
    figures: [],
    collectionIds: [],
    createdAt: new Date(Date.now() - 7_200_000).toISOString(),
    updatedAt: new Date(Date.now() - 7200_000).toISOString(),
    isFavorite: false,
    readingProgress: 0,
    error: "Encrypted PDF: a password is required before layout parsing can continue.",
  },
];

export const demoMarkdown = `# Evidence-Grounded Graph Reasoning for Scientific Discovery

## Abstract

Scientific assistants need to preserve the path from a generated claim back to the exact passage that supports it. We introduce a local-first pipeline that combines document structure, evidence anchors, and explicit comparison rules.

## 1. Introduction

Existing literature tools are effective at discovery, but their summaries often separate conclusions from source context. Our approach keeps every extracted statement attached to a paper, section, page, and source block.

> The primary design constraint is traceability: a reader must be able to inspect the original evidence without repeating the search process.

## 2. Method

The system operates in three stages. First, each PDF is normalized into a structured document. Second, evidence-aware retrieval selects comparable passages. Third, a constrained synthesis step separates supported findings from open hypotheses.

The context budget is computed before execution:

$$B_{safe} = B_{context} - B_{output} - B_{system} - B_{tools} - B_{buffer}$$

| Stage | Input | Persistent output |
| --- | --- | --- |
| Ingestion | PDF bytes | SHA-256 and file record |
| Parsing | Stable PDF | Markdown and document JSON |
| Grounding | Structured blocks | Evidence anchors |

## 3. Evaluation

We evaluate section ordering, page localization, and whether each synthesized claim is supported by its cited source text. Direct metric comparisons are disabled when experimental settings differ.

## 4. Limitations

Scanned PDFs require OCR, and complex vector figures may not expose reusable embedded images. These cases remain visible as partial results instead of being silently omitted.
`;
