import type { AgentProfile, AgentPromptTemplate, AgentRun, AgentToolCallRecord, CitationGraphResult, CitationReference, ContextCompressionRecord, ContextDraft, ContextDraftItem, ContextLoadMode, ContextSnapshot, ContextSourceItem, DocumentUncertainty, FigureAnalysis, InnovationPromptRevision, InnovationRun, InnovationStageId, JobStage, LibraryCollection, LibraryPaper, ModelActivityMeta, ModelStreamEvent, ModelStreamRequest, ModelToolDefinition, PaperDocument, PaperEngagement, PdfImportOptions, PdfImportPreview, PreprocessQualityReport, ProgressNotification, PromptTemplate, PromptTemplateCategory, ReaderAnalysisRecord, ReaderAnalysisType, ReaderAnnotation, ReaderChatTurn, ReaderConversation, ScopedContextItem, TranslationRecord, ZoteroImportCandidate, ZoteroImportResult, ZoteroInspection } from "@p2i/contracts";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { demoMarkdown, demoPapers } from "../demo";
import { sanitizeProviderConfig } from "./providerConfig";
import { applyModelStreamEvent, beginModelActivity, failModelActivity } from "./modelActivity";
import { DEFAULT_PROMPT_TEMPLATES } from "./promptTemplates";

export const nativeRuntime = isTauri();

let demoCollections: LibraryCollection[] = [
  { id: "demo-research", name: "研究主题", color: "#3984d8", sortOrder: 0, paperCount: 0, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
  { id: "demo-methods", name: "基础模型", parentId: "demo-research", color: "#4f6bed", sortOrder: 0, paperCount: 1, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
  { id: "demo-multimodal-group", name: "多模态", parentId: "demo-research", color: "#28a06a", sortOrder: 1, paperCount: 1, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
];

async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return invoke<T>("rpc_call", { method, params });
}

export async function chooseLibrary(): Promise<string | null> {
  if (!nativeRuntime) return "D:/Research/Papers2Innovations-Library";
  return invoke<string | null>("choose_library");
}

export async function chooseZoteroDirectory(): Promise<string | null> {
  if (!nativeRuntime) return "C:/Users/Researcher/Zotero";
  return invoke<string | null>("choose_zotero_directory");
}

export interface PdfImportResult {
  selected: number;
  copied: number;
  deduplicated: number;
  destination: string;
}

export async function selectPdfPaths(): Promise<string[]> {
  if (!nativeRuntime) return ["D:/Research/example-paper.pdf"];
  return invoke<string[]>("select_pdf_paths");
}

export async function previewPdfImport(root: string, paths: string[]): Promise<PdfImportPreview> {
  if (!nativeRuntime) return {
    items: paths.map((path) => ({ path, filename: path.split(/[\\/]/).at(-1) ?? "paper.pdf", pageCount: 12, sizeBytes: 1_200_000, encrypted: false })),
    fileCount: paths.length, pageCount: paths.length * 12, estimatedVisionCalls: paths.length * 12,
    visionReady: true, visionModelId: "demo-vision", visionModelName: "演示视觉模型",
  };
  return invoke<PdfImportPreview>("preview_pdf_import", { root, paths });
}

export async function importPdfs(root: string, paths: string[] = [], options: PdfImportOptions = { processingMode: "local", visionConfirmed: false }): Promise<PdfImportResult> {
  if (!nativeRuntime) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return { selected: paths.length || 2, copied: paths.length || 2, deduplicated: 0, destination: `${root}/Papers/Manual` };
  }
  return paths.length
    ? invoke<PdfImportResult>("import_pdf_paths", { root, paths, options })
    : invoke<PdfImportResult>("import_pdfs", { root });
}

export async function listDocumentUncertainties(root: string, paperId: string): Promise<DocumentUncertainty[]> {
  if (!nativeRuntime) return [];
  return rpc<DocumentUncertainty[]>("paper.uncertainty_list", { root, paperId });
}

export async function previewPaperReprocessing(root: string, paperIds: string[]): Promise<{ paperCount: number; pageCount: number; estimatedVisionCalls: number; visionReady: boolean; visionModelId?: string }> {
  return rpc("paper.reprocess_preview", { root, paperIds });
}

export async function reprocessPapers(root: string, paperIds: string[], visionConfirmed: boolean): Promise<Array<{ jobId: string; paperId: string }>> {
  return rpc("paper.reprocess_batch", { root, paperIds, visionConfirmed });
}

export async function initializeLibrary(root: string): Promise<void> {
  if (!nativeRuntime) return;
  await rpc("library.initialize", { root });
}

export async function scanLibrary(root: string, requireStable = false): Promise<void> {
  if (!nativeRuntime) {
    await new Promise((resolve) => setTimeout(resolve, 550));
    return;
  }
  await rpc("library.scan", { root, requireStable });
}

export async function listPapers(root: string): Promise<LibraryPaper[]> {
  if (!nativeRuntime) return demoPapers.map((paper) => ({ ...paper, collectionIds: [...paper.collectionIds] }));
  return rpc<LibraryPaper[]>("library.list", { root });
}

export async function setPaperFavorite(root: string, paperId: string, favorite: boolean): Promise<PaperEngagement> {
  if (!nativeRuntime) {
    const paper = demoPapers.find((item) => item.id === paperId);
    if (!paper) throw new Error("论文不存在");
    paper.isFavorite = favorite;
    paper.favoritedAt = favorite ? new Date().toISOString() : undefined;
    return { paperId, isFavorite: favorite, favoritedAt: paper.favoritedAt, lastOpenedAt: paper.lastOpenedAt, lastReadAt: paper.lastReadAt, lastSectionId: paper.lastSectionId, lastPage: paper.lastPage, readingProgress: paper.readingProgress, updatedAt: new Date().toISOString() };
  }
  return rpc<PaperEngagement>("paper.favorite_set", { root, paperId, favorite });
}

export async function updatePaperReading(root: string, paperId: string, state: { progress?: number; lastSectionId?: string; lastPage?: number } = {}): Promise<PaperEngagement> {
  if (!nativeRuntime) {
    const paper = demoPapers.find((item) => item.id === paperId);
    if (!paper) throw new Error("论文不存在");
    const now = new Date().toISOString();
    paper.lastOpenedAt = now;
    paper.lastReadAt = now;
    if (state.lastSectionId) paper.lastSectionId = state.lastSectionId;
    if (state.lastPage) paper.lastPage = state.lastPage;
    if (state.progress !== undefined) paper.readingProgress = state.progress;
    return { paperId, isFavorite: paper.isFavorite, favoritedAt: paper.favoritedAt, lastOpenedAt: now, lastReadAt: now, lastSectionId: paper.lastSectionId, lastPage: paper.lastPage, readingProgress: paper.readingProgress, updatedAt: now };
  }
  return rpc<PaperEngagement>("paper.reading_update", { root, paperId, ...state });
}

export async function listCollections(root: string): Promise<LibraryCollection[]> {
  if (!nativeRuntime) return demoCollections.map((item) => ({ ...item }));
  return rpc<LibraryCollection[]>("collection.list", { root });
}

export async function createCollection(root: string, input: { name: string; parentId?: string; color?: string }): Promise<LibraryCollection> {
  if (!nativeRuntime) {
    const now = new Date().toISOString();
    const collection: LibraryCollection = { id: crypto.randomUUID(), name: input.name, parentId: input.parentId, color: input.color ?? "#4f6bed", sortOrder: demoCollections.filter((item) => item.parentId === input.parentId).length, paperCount: 0, createdAt: now, updatedAt: now };
    demoCollections = [...demoCollections, collection];
    return collection;
  }
  return rpc<LibraryCollection>("collection.create", { root, ...input });
}

export async function updateCollection(root: string, collectionId: string, patch: { name?: string; parentId?: string | null; color?: string; sortOrder?: number }): Promise<LibraryCollection> {
  if (!nativeRuntime) {
    const current = demoCollections.find((item) => item.id === collectionId);
    if (!current) throw new Error("分类不存在");
    const updated: LibraryCollection = { ...current, ...patch, parentId: patch.parentId === null ? undefined : patch.parentId ?? current.parentId, updatedAt: new Date().toISOString() };
    demoCollections = demoCollections.map((item) => item.id === collectionId ? updated : item);
    return updated;
  }
  return rpc<LibraryCollection>("collection.update", { root, collectionId, ...patch });
}

export async function deleteCollection(root: string, collectionId: string): Promise<void> {
  if (!nativeRuntime) {
    const descendants = new Set<string>([collectionId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of demoCollections) if (item.parentId && descendants.has(item.parentId) && !descendants.has(item.id)) { descendants.add(item.id); changed = true; }
    }
    demoCollections = demoCollections.filter((item) => !descendants.has(item.id));
    for (const paper of demoPapers) paper.collectionIds = paper.collectionIds.filter((id) => !descendants.has(id));
    return;
  }
  await rpc("collection.delete", { root, collectionId });
}

export async function movePaperToCollection(root: string, paperId: string, collectionId?: string): Promise<void> {
  if (!nativeRuntime) {
    const paper = demoPapers.find((item) => item.id === paperId);
    if (!paper) throw new Error("论文不存在");
    paper.collectionIds = collectionId ? [collectionId] : [];
    demoCollections = demoCollections.map((item) => ({ ...item, paperCount: demoPapers.filter((paperItem) => paperItem.collectionIds.includes(item.id)).length }));
    return;
  }
  await rpc("collection.move_paper", { root, paperId, collectionId });
}

export async function readMarkdown(root: string, paperId: string): Promise<string> {
  if (!nativeRuntime) return demoMarkdown;
  const result = await rpc<{ markdown: string }>("paper.read_markdown", { root, paperId });
  return result.markdown;
}

export async function readDocument(root: string, paperId: string): Promise<PaperDocument> {
  if (!nativeRuntime) {
    return {
      schema_version: "1.0",
      paper_id: paperId,
      source_sha256: "demo-source-hash",
      title: demoPapers.find((paper) => paper.id === paperId)?.title ?? "Demo paper",
      authors: [],
      page_count: 1,
      sections: [{ id: "demo-section", title: "Paper", level: 1, order: 0, markdown: demoMarkdown, anchors: [] }],
      figures: [],
      tables: [],
      parser: { name: "demo", version: "1" },
      generated_at: new Date(0).toISOString(),
    };
  }
  return rpc<PaperDocument>("paper.read_document", { root, paperId });
}

export async function listFigureAnalyses(root: string, paperId: string): Promise<FigureAnalysis[]> {
  if (!nativeRuntime) return [];
  return rpc<FigureAnalysis[]>("figure.analysis_list", { root, paperId });
}

export async function retryFigureAnalysis(root: string, paperId: string, figureId: string): Promise<FigureAnalysis[]> {
  if (!nativeRuntime) return [];
  return rpc<FigureAnalysis[]>("figure.analysis_retry", { root, paperId, figureId });
}

export async function getPreprocessStatus(root: string, paperId: string): Promise<PreprocessQualityReport> {
  if (!nativeRuntime) return { paperId, sourceHash: "", formulaIssueCount: 0, repairedFormulaCount: 0, figureCount: 0, analyzedFigureCount: 0, failedFigureCount: 0, recognizedPageCount: 0, cachedPageCount: 0, failedPageCount: 0, uncertainRegionCount: 0, removedHeaderFooterCount: 0, usage: { inputTokens: 0, outputTokens: 0, durationMs: 0 }, warnings: [], updatedAt: new Date().toISOString() };
  return rpc<PreprocessQualityReport>("paper.preprocess_status", { root, paperId });
}

export async function saveFormattedDocument(root: string, input: {
  paperId: string;
  sections: Array<{ id: string; markdown: string }>;
  modelId: string;
  promptVersion: string;
  sourceSha256: string;
}): Promise<PaperDocument> {
  if (!nativeRuntime) {
    const document = await readDocument(root, input.paperId);
    return {
      ...document,
      sections: document.sections.map((section) => ({ ...section, markdown: input.sections.find((item) => item.id === section.id)?.markdown ?? section.markdown })),
      formatting: { model_id: input.modelId, prompt_version: input.promptVersion, source_sha256: input.sourceSha256, updated_at: new Date().toISOString() },
    };
  }
  return rpc<PaperDocument>("paper.format_markdown_save", { root, ...input });
}

export async function readReferences(root: string, paperId: string): Promise<CitationReference[]> {
  if (!nativeRuntime) return [];
  return rpc<CitationReference[]>("paper.read_references", { root, paperId });
}

export async function buildCitationGraph(root: string, paperId: string, force = false): Promise<CitationGraphResult> {
  if (!nativeRuntime) {
    const paper = demoPapers.find((candidate) => candidate.id === paperId) ?? demoPapers[0];
    const direct = demoPapers.filter((candidate) => candidate.id !== paper.id).slice(0, 2);
    const externalDirect = [
      ["demo-direct-1", "Evidence traceability in scientific question answering", 2024],
      ["demo-direct-2", "Document structure aware retrieval for long papers", 2023],
      ["demo-direct-3", "Local-first research assistants with source grounding", 2025],
      ["demo-direct-4", "Reliable multimodal extraction from scholarly PDF files", 2022],
    ] as const;
    const secondLevel = [
      ["demo-second-1", "Citation-aware synthesis for literature reviews", 2021],
      ["demo-second-2", "Evaluating evidence attribution in language models", 2024],
      ["demo-second-3", "Structured document representations for retrieval", 2020],
      ["demo-second-4", "Unresolved reference on scientific provenance", 2019],
    ] as const;
    const nodes: CitationGraphResult["nodes"] = [
      { id: paper.id, paperId: paper.id, title: paper.title, authors: [], depth: 0, degree: direct.length + externalDirect.length, resolved: true, status: "ready" },
      ...direct.map((candidate, index) => ({ id: candidate.id, paperId: candidate.id, title: candidate.title, authors: ["P2I Demo Team"], depth: 1 as const, degree: 3 + index, resolved: true, status: "ready" as const, year: 2025 + index })),
      ...externalDirect.map(([id, title, year], index) => ({ id, title, authors: ["Research Group"], depth: 1 as const, degree: 2 + (index % 3), resolved: false, status: "unresolved" as const, year })),
      ...secondLevel.map(([id, title, year], index) => ({ id, title, authors: ["Evidence Lab"], depth: 2 as const, degree: 1 + (index % 2), resolved: index < 3, status: index < 3 ? "ready" as const : "unresolved" as const, year })),
    ];
    const rootEdges = [
      ...direct.map((candidate) => ({ id: `cites:${paper.id}:${candidate.id}`, source: paper.id, target: candidate.id, relation: "cites" as const, weight: 1 })),
      ...externalDirect.map(([id], index) => ({ id: `cites:${paper.id}:${id}`, source: paper.id, target: id, relation: "cites" as const, weight: 1 + (index % 2) })),
    ];
    const secondaryEdges = secondLevel.map(([id], index) => ({
      id: `cites:${externalDirect[index % externalDirect.length][0]}:${id}`,
      source: externalDirect[index % externalDirect.length][0],
      target: id,
      relation: "cites" as const,
      weight: 1,
    }));
    const similarityEdges = [
      { id: "similarity:direct-1:direct-3", source: "demo-direct-1", target: "demo-direct-3", relation: "topic_similarity" as const, weight: 3 },
      { id: "shared:direct-2:paper-2", source: "demo-direct-2", target: direct[0]?.id ?? paper.id, relation: "shared_reference" as const, weight: 2 },
    ];
    return {
      schemaVersion: 1,
      rootPaperId: paper.id,
      maxDepth: 2,
      status: "partial",
      nodes,
      edges: [...rootEdges, ...secondaryEdges, ...similarityEdges],
      directCount: direct.length + externalDirect.length,
      secondLevelCount: secondLevel.length,
      unresolvedCount: externalDirect.length + 1,
      warnings: ["Some references are not yet linked to local PDF files."],
      libraryFingerprint: "demo-library",
      generatedAt: new Date().toISOString(),
      cacheHit: false,
    };
  }
  return rpc<CitationGraphResult>("graph.build", { root, paperId, maxDepth: 2, force });
}

let demoTranslations: TranslationRecord[] = [];
let demoReaderAnnotations: ReaderAnnotation[] = [];

export async function listTranslations(root: string, paperId: string): Promise<TranslationRecord[]> {
  if (!nativeRuntime) return demoTranslations.filter((record) => record.paperId === paperId);
  return rpc<TranslationRecord[]>("translation.list", { root, paperId });
}

export async function saveTranslation(root: string, input: Omit<TranslationRecord, "id" | "sourceHash" | "revision" | "createdAt" | "updatedAt" | "sourceStart" | "sourceEnd" | "segments" | "terms"> & Partial<Pick<TranslationRecord, "sourceStart" | "sourceEnd" | "segments" | "terms">>): Promise<TranslationRecord> {
  if (!nativeRuntime) {
    const now = new Date().toISOString();
    const previous = demoTranslations.filter((record) => record.paperId === input.paperId && record.blockId === input.blockId && record.sourceStart === (input.sourceStart ?? 0) && record.sourceEnd === (input.sourceEnd ?? input.sourceText.length));
    const record = { ...input, sourceStart: input.sourceStart ?? 0, sourceEnd: input.sourceEnd ?? input.sourceText.length, segments: input.segments ?? [], terms: input.terms ?? [], id: crypto.randomUUID(), sourceHash: "demo-source-hash", revision: Math.max(0, ...previous.map((item) => item.revision)) + 1, createdAt: now, updatedAt: now } satisfies TranslationRecord;
    demoTranslations = [...demoTranslations.filter((item) => !previous.some((candidate) => candidate.id === item.id)), record];
    demoReaderAnnotations = [...demoReaderAnnotations.filter((annotation) => !(annotation.targetType === "translation" && previous.some((candidate) => candidate.id === annotation.relatedId))), { id: crypto.randomUUID(), paperId: record.paperId, sectionId: record.sectionId, blockId: record.blockId, sourceHash: record.sourceHash, sourceStart: record.sourceStart, sourceEnd: record.sourceEnd, annotationType: "translation", targetType: "translation", relatedId: record.id, selectedText: record.sourceText.slice(record.sourceStart, record.sourceEnd), anchorHash: "demo-anchor-hash", createdAt: now, updatedAt: now }];
    return record;
  }
  return rpc<TranslationRecord>("translation.save", { root, ...input });
}

export async function deleteTranslation(root: string, paperId: string, translationId: string): Promise<void> {
  if (!nativeRuntime) {
    demoTranslations = demoTranslations.filter((record) => record.id !== translationId);
    demoReaderAnnotations = demoReaderAnnotations.filter((annotation) => annotation.relatedId !== translationId);
    return;
  }
  await rpc("translation.delete", { root, paperId, translationId });
}

export async function listReaderAnnotations(root: string, paperId: string): Promise<ReaderAnnotation[]> {
  if (!nativeRuntime) return demoReaderAnnotations.filter((annotation) => annotation.paperId === paperId);
  return rpc<ReaderAnnotation[]>("reader.annotation_list", { root, paperId });
}

export async function saveReaderAnnotation(root: string, input: Omit<ReaderAnnotation, "id" | "sourceHash" | "createdAt" | "updatedAt" | "targetType" | "selectedText" | "anchorHash"> & Partial<Pick<ReaderAnnotation, "targetType" | "selectedText">>): Promise<ReaderAnnotation> {
  if (!nativeRuntime) {
    const record = { ...input, targetType: input.targetType ?? (input.annotationType === "translation" ? "translation" : "conversation"), selectedText: input.selectedText ?? "", anchorHash: "demo-anchor-hash", id: crypto.randomUUID(), sourceHash: "demo-source-hash", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } satisfies ReaderAnnotation;
    demoReaderAnnotations = [...demoReaderAnnotations, record];
    return record;
  }
  return rpc<ReaderAnnotation>("reader.annotation_save", { root, ...input });
}

export async function deleteReaderAnnotation(root: string, paperId: string, annotationId: string): Promise<void> {
  if (!nativeRuntime) {
    demoReaderAnnotations = demoReaderAnnotations.filter((annotation) => annotation.id !== annotationId);
    return;
  }
  await rpc("reader.annotation_delete", { root, paperId, annotationId });
}

let demoReaderAnalyses: ReaderAnalysisRecord[] = [];
let demoReaderConversation: ReaderConversation | null = null;

export async function listReaderAnalyses(root: string, paperId: string): Promise<ReaderAnalysisRecord[]> {
  if (!nativeRuntime) return demoReaderAnalyses.filter((record) => record.paperId === paperId);
  return rpc<ReaderAnalysisRecord[]>("reader.analysis_list", { root, paperId });
}

export async function saveReaderAnalysis(root: string, input: {
  paperId: string;
  sectionId: string;
  blockId: string;
  analysisType: ReaderAnalysisType;
  sourceText: string;
  adjacentContext: string;
  resultText: string;
  modelId: string;
  promptVersion: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  sourceStart?: number;
  sourceEnd?: number;
  selectedText?: string;
}): Promise<ReaderAnalysisRecord> {
  if (!nativeRuntime) {
    const now = new Date().toISOString();
    const previous = demoReaderAnalyses.filter((record) => record.paperId === input.paperId && record.blockId === input.blockId && record.analysisType === input.analysisType);
    const record: ReaderAnalysisRecord = {
      ...input,
      id: crypto.randomUUID(),
      sourceHash: "demo-source-hash",
      revision: Math.max(0, ...previous.map((item) => item.revision)) + 1,
      usage: { inputTokens: input.inputTokens ?? 0, outputTokens: input.outputTokens ?? 0, durationMs: input.durationMs ?? 0 },
      createdAt: now,
      updatedAt: now,
    };
    demoReaderAnalyses = [...demoReaderAnalyses.filter((item) => !(item.paperId === record.paperId && item.blockId === record.blockId && item.analysisType === record.analysisType)), record];
    demoReaderAnnotations = [...demoReaderAnnotations.filter((annotation) => !(annotation.targetType === "analysis" && previous.some((item) => item.id === annotation.relatedId))), {
      id: crypto.randomUUID(), paperId: record.paperId, sectionId: record.sectionId, blockId: record.blockId,
      sourceHash: record.sourceHash, sourceStart: input.sourceStart ?? 0, sourceEnd: input.sourceEnd ?? input.sourceText.length,
      annotationType: "chat", targetType: "analysis", relatedId: record.id, selectedText: input.selectedText ?? input.sourceText,
      anchorHash: "demo-anchor-hash", createdAt: now, updatedAt: now,
    }];
    return record;
  }
  return rpc<ReaderAnalysisRecord>("reader.analysis_save", { root, ...input });
}

export async function deleteReaderAnalysis(root: string, paperId: string, analysisId: string): Promise<void> {
  if (!nativeRuntime) {
    demoReaderAnalyses = demoReaderAnalyses.filter((record) => record.id !== analysisId);
    demoReaderAnnotations = demoReaderAnnotations.filter((annotation) => annotation.relatedId !== analysisId);
    return;
  }
  await rpc("reader.analysis_delete", { root, paperId, analysisId });
}

export async function getReaderConversation(root: string, paperId: string): Promise<ReaderConversation> {
  if (!nativeRuntime) return demoReaderConversation?.paperId === paperId ? demoReaderConversation : { id: "", paperId, turns: [] };
  return rpc<ReaderConversation>("reader.chat_get", { root, paperId });
}

export async function saveReaderChatTurn(root: string, input: {
  paperId: string;
  turnId?: string;
  userMessage: string;
  assistantText: string;
  contextSnapshot: ContextSnapshot;
  modelId: string;
  promptVersion: string;
  status: "completed" | "cancelled" | "failed";
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  error?: string;
}): Promise<ReaderChatTurn> {
  if (!nativeRuntime) {
    const now = new Date().toISOString();
    const existingTurns = demoReaderConversation?.paperId === input.paperId ? demoReaderConversation.turns : [];
    const existing = input.turnId ? existingTurns.find((turn) => turn.id === input.turnId) : undefined;
    const turn: ReaderChatTurn = {
      id: existing?.id ?? crypto.randomUUID(),
      turnIndex: existing?.turnIndex ?? existingTurns.length + 1,
      userMessage: input.userMessage,
      contextSnapshot: input.contextSnapshot,
      revisions: [...(existing?.revisions ?? []), {
        id: crypto.randomUUID(), turnId: existing?.id ?? "demo-pending", userMessage: input.userMessage,
        contextSnapshot: input.contextSnapshot, revision: (existing?.revisions.length ?? 0) + 1, createdAt: now,
      }],
      createdAt: existing?.createdAt ?? now,
      response: {
        id: crypto.randomUUID(),
        assistantText: input.assistantText,
        modelId: input.modelId,
        promptVersion: input.promptVersion,
        revision: (existing?.response?.revision ?? 0) + 1,
        status: input.status,
        usage: { inputTokens: input.inputTokens ?? 0, outputTokens: input.outputTokens ?? 0, durationMs: input.durationMs ?? 0 },
        error: input.error,
        createdAt: now,
        updatedAt: now,
      },
    };
    const turns = [...existingTurns.filter((item) => item.id !== turn.id), turn].sort((left, right) => left.turnIndex - right.turnIndex);
    demoReaderConversation = { id: demoReaderConversation?.id || crypto.randomUUID(), paperId: input.paperId, turns, createdAt: demoReaderConversation?.createdAt ?? now, updatedAt: now };
    return turn;
  }
  return rpc<ReaderChatTurn>("reader.chat_save", { root, ...input });
}

export async function updateReaderChatTurn(root: string, input: Parameters<typeof saveReaderChatTurn>[1] & { turnId: string }): Promise<ReaderChatTurn> {
  if (!nativeRuntime) return saveReaderChatTurn(root, input);
  return rpc<ReaderChatTurn>("reader.chat_turn_update", { root, ...input });
}

export async function deleteReaderChatTurn(root: string, paperId: string, turnId: string): Promise<void> {
  if (!nativeRuntime) {
    if (demoReaderConversation?.paperId === paperId) {
      demoReaderConversation = { ...demoReaderConversation, turns: demoReaderConversation.turns.filter((turn) => turn.id !== turnId) };
    }
    demoReaderAnnotations = demoReaderAnnotations.filter((annotation) => annotation.relatedId !== turnId);
    return;
  }
  await rpc("reader.chat_turn_delete", { root, paperId, turnId });
}

export async function clearReaderConversation(root: string, paperId: string): Promise<void> {
  if (!nativeRuntime) {
    if (demoReaderConversation?.paperId === paperId) demoReaderConversation = null;
    return;
  }
  await rpc("reader.chat_clear", { root, paperId });
}

let demoContextItems: ContextDraftItem[] = [];
const demoContextCompressions = new Map<string, ContextCompressionRecord>();
const demoCompressionKey = (itemId: string, modelId: string, promptVersion: string) => `${itemId}:${modelId}:${promptVersion}`;

function demoContextDraft(): ContextDraft {
  return {
    items: demoContextItems,
    tokenBreakdown: {
      systemPrompt: 4200,
      tools: 7800,
      conversation: 0,
      papers: demoContextItems.reduce((total, item) => total + item.estimatedTokens, 0),
      figures: 0,
      outputReserve: 16000,
      safetyBuffer: 8000,
    },
    updatedAt: demoContextItems.at(-1)?.updatedAt,
  };
}

export async function getContextDraft(root: string, scopeId = "research:default"): Promise<ContextDraft> {
  if (!nativeRuntime) return demoContextDraft();
  return rpc<ContextDraft>("context.get", { root, scopeId });
}

export async function addPaperToContext(root: string, paperId: string, mode: Extract<ContextLoadMode, "full" | "structured"> = "full", scopeId = "research:default"): Promise<ContextDraft> {
  if (!nativeRuntime) {
    const paper = demoPapers.find((item) => item.id === paperId);
    if (!paper) throw new Error("Unknown paper.");
    const now = new Date().toISOString();
    demoContextItems = [
      ...demoContextItems.filter((item) => item.paperId !== paperId || item.sectionId || item.blockId),
      {
        id: `demo-context-${paperId}`,
        paperId,
        paperTitle: paper.title,
        mode,
        sourceHash: paper.id,
        sourcePreview: demoMarkdown.slice(0, 240),
        estimatedTokens: Math.ceil(new TextEncoder().encode(demoMarkdown).length / 4),
        createdAt: now,
        updatedAt: now,
      },
    ];
    return demoContextDraft();
  }
  return rpc<ContextDraft>("context.add_paper", { root, paperId, mode, scopeId });
}

export async function addSelectionToContext(root: string, input: { paperId: string; sectionId: string; blockId?: string; sourceText: string; scopeId?: string; title?: string }): Promise<ContextDraft> {
  if (!nativeRuntime) {
    const paper = demoPapers.find((item) => item.id === input.paperId);
    if (!paper) throw new Error("Unknown paper.");
    const now = new Date().toISOString();
    const itemId = `${input.paperId}:${input.sectionId}:${input.blockId ?? ""}`;
    demoContextItems = [
      ...demoContextItems.filter((item) => item.id !== itemId),
      {
        id: itemId,
        paperId: input.paperId,
        paperTitle: paper.title,
        sectionId: input.sectionId,
        blockId: input.blockId,
        mode: "sections",
        sourceHash: paper.id,
        sourcePreview: input.sourceText.slice(0, 240),
        estimatedTokens: Math.ceil(new TextEncoder().encode(input.sourceText).length / 4),
        createdAt: now,
        updatedAt: now,
      },
    ];
    return demoContextDraft();
  }
  return rpc<ContextDraft>("context.add_selection", { root, ...input });
}

export async function readContextItem(root: string, itemId: string, scopeId = "research:default"): Promise<ContextSourceItem> {
  if (!nativeRuntime) {
    const item = demoContextItems.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error("Unknown context item.");
    return {
      id: item.id,
      paperId: item.paperId,
      paperTitle: item.paperTitle,
      sectionId: item.sectionId,
      blockId: item.blockId,
      sourceHash: item.sourceHash,
      sourceText: item.sourcePreview,
      estimatedTokens: item.estimatedTokens,
    };
  }
  return rpc<ContextSourceItem>("context.read_item", { root, itemId, scopeId });
}

export async function getContextCompression(root: string, itemId: string, modelId: string, promptVersion: string): Promise<ContextCompressionRecord | null> {
  if (!nativeRuntime) return demoContextCompressions.get(demoCompressionKey(itemId, modelId, promptVersion)) ?? null;
  return rpc<ContextCompressionRecord | null>("context.get_compression", { root, itemId, modelId, promptVersion });
}

export async function activateContextCompression(root: string, itemId: string, modelId: string, promptVersion: string, scopeId = "research:default"): Promise<ContextDraft> {
  if (!nativeRuntime) {
    const record = demoContextCompressions.get(demoCompressionKey(itemId, modelId, promptVersion));
    if (!record) throw new Error("No cached compression matches the current source and model.");
    demoContextItems = demoContextItems.map((item) => item.id === itemId ? {
      ...item,
      mode: "compressed",
      estimatedTokens: record.estimatedTokens,
      compression: record,
    } : item);
    return demoContextDraft();
  }
  return rpc<ContextDraft>("context.activate_compression", { root, itemId, modelId, promptVersion, scopeId });
}

export async function saveContextCompression(root: string, input: { itemId: string; sourceHash: string; compressedText: string; modelId: string; promptVersion: string; inputTokens?: number; outputTokens?: number; durationMs?: number }): Promise<ContextCompressionRecord> {
  if (!nativeRuntime) {
    const now = new Date().toISOString();
    const record: ContextCompressionRecord = {
      id: crypto.randomUUID(),
      ...input,
      revision: 1,
      estimatedTokens: Math.ceil(new TextEncoder().encode(input.compressedText).length / 4),
      usage: {
        inputTokens: input.inputTokens ?? 0,
        outputTokens: input.outputTokens ?? 0,
        durationMs: input.durationMs ?? 0,
      },
      preview: input.compressedText.slice(0, 240),
      createdAt: now,
      updatedAt: now,
    };
    demoContextCompressions.set(demoCompressionKey(input.itemId, input.modelId, input.promptVersion), record);
    demoContextItems = demoContextItems.map((item) => item.id === input.itemId ? {
      ...item,
      mode: "compressed",
      estimatedTokens: record.estimatedTokens,
      compression: record,
      updatedAt: now,
    } : item);
    return record;
  }
  return rpc<ContextCompressionRecord>("context.save_compression", { root, ...input });
}

export async function removePaperFromContext(root: string, paperId: string, scopeId = "research:default"): Promise<ContextDraft> {
  if (!nativeRuntime) {
    demoContextItems = demoContextItems.filter((item) => item.paperId !== paperId);
    return demoContextDraft();
  }
  return rpc<ContextDraft>("context.remove_paper", { root, paperId, scopeId });
}

export async function clearContext(root: string, scopeId = "research:default"): Promise<ContextDraft> {
  if (!nativeRuntime) {
    demoContextItems = [];
    return demoContextDraft();
  }
  return rpc<ContextDraft>("context.clear", { root, scopeId });
}

export async function upsertScopedContextItem(root: string, input: { scopeId: string; paperId?: string; itemId?: string; title: string; text: string }): Promise<ContextDraft> {
  if (!nativeRuntime) return demoContextDraft();
  return rpc<ContextDraft>("context.item_upsert", { root, ...input });
}

export async function deleteScopedContextItem(root: string, scopeId: string, itemId: string): Promise<ContextDraft> {
  if (!nativeRuntime) return demoContextDraft();
  return rpc<ContextDraft>("context.item_delete", { root, scopeId, itemId });
}

export async function resetContextScope(root: string, scopeId: string): Promise<ContextDraft> {
  if (!nativeRuntime) return demoContextDraft();
  return rpc<ContextDraft>("context.scope_reset", { root, scopeId });
}

export async function readScopedContextItem(root: string, scopeId: string, itemId: string): Promise<ScopedContextItem> {
  return readContextItem(root, itemId, scopeId) as Promise<ScopedContextItem>;
}

const demoAgentNow = new Date(0).toISOString();
let demoAgentProfiles: AgentProfile[] = [
  {
    id: "paper-analyst",
    name: "论文分析助手",
    description: "解释论文内容，并让每条论断都有本地证据支持。",
    color: "#4f6bed",
    enabled: true,
    providerId: "provider-openai-demo",
    modelId: "custom-chat-model",
    credentialId: "provider-openai-demo",
    maxContextTokens: 128000,
    maxOutputTokens: 4096,
    contextSafetyRatio: 0.85,
    temperature: 0.2,
    timeoutSeconds: 90,
    maxRetries: 2,
    allowedTools: ["read_paper", "read_section", "find_evidence"],
    networkPolicy: "none",
    writePolicy: "confirm-write",
    systemPromptId: "system:paper-analyst",
    systemPrompt: "你是科研论文分析助手。请默认使用中文，只根据提供的上下文回答，并引用证据锚点。",
    promptVersion: "agent-v1",
    createdAt: demoAgentNow,
    updatedAt: demoAgentNow,
  },
  {
    id: "innovation-agent",
    name: "创新研究助手",
    description: "根据有据可查的上下文生成可验证的研究方向。",
    color: "#d98916",
    enabled: true,
    providerId: "provider-openai-demo",
    modelId: "custom-reasoning-model",
    credentialId: "provider-openai-demo",
    maxContextTokens: 128000,
    maxOutputTokens: 8192,
    contextSafetyRatio: 0.85,
    temperature: 0.3,
    timeoutSeconds: 90,
    maxRetries: 2,
    allowedTools: ["search_library", "read_paper", "find_evidence", "create_note"],
    networkPolicy: "academic",
    writePolicy: "confirm-write",
    systemPromptId: "system:innovation-agent",
    systemPrompt: "请默认使用中文，根据给定证据生成可验证的研究想法，并为每项事实前提引用证据。",
    promptVersion: "agent-v1",
    createdAt: demoAgentNow,
    updatedAt: demoAgentNow,
  },
];
let demoAgentPrompts: AgentPromptTemplate[] = demoAgentProfiles.map((profile) => ({
  id: `prompt:${profile.id}:default`,
  agentProfileId: profile.id,
  name: "默认分析任务",
  content: "请分析当前研究上下文，提炼最重要且有证据支持的结论，并指出证据不足之处。",
  sortOrder: 0,
  createdAt: demoAgentNow,
  updatedAt: demoAgentNow,
}));
let demoAgentRuns: AgentRun[] = [];
let demoPromptTemplates: PromptTemplate[] = DEFAULT_PROMPT_TEMPLATES.map((template) => ({ ...template }));

export async function listPromptTemplates(root: string, category?: PromptTemplateCategory): Promise<PromptTemplate[]> {
  if (!nativeRuntime) return demoPromptTemplates.filter((template) => !category || template.category === category).sort((left, right) => left.sortOrder - right.sortOrder || right.updatedAt.localeCompare(left.updatedAt));
  return rpc<PromptTemplate[]>("prompt.list", { root, category });
}

export async function upsertPromptTemplate(root: string, input: { id?: string; category: PromptTemplateCategory; name: string; content: string; sortOrder?: number }): Promise<PromptTemplate> {
  if (!nativeRuntime) {
    const now = new Date().toISOString();
    const previous = demoPromptTemplates.find((template) => template.id === input.id);
    const duplicate = demoPromptTemplates.some((template) => template.category === input.category && template.name.toLowerCase() === input.name.trim().toLowerCase() && template.id !== input.id);
    if (duplicate) throw new Error("该分类中已存在同名提示词。");
    const saved: PromptTemplate = { id: input.id ?? crypto.randomUUID(), category: input.category, name: input.name.trim(), content: input.content.trim(), sortOrder: input.sortOrder ?? previous?.sortOrder ?? 0, createdAt: previous?.createdAt ?? now, updatedAt: now };
    demoPromptTemplates = [...demoPromptTemplates.filter((template) => template.id !== saved.id), saved];
    return saved;
  }
  return rpc<PromptTemplate>("prompt.upsert", { root, ...input });
}

export async function deletePromptTemplate(root: string, templateId: string): Promise<void> {
  if (!nativeRuntime) {
    demoPromptTemplates = demoPromptTemplates.filter((template) => template.id !== templateId);
    return;
  }
  await rpc("prompt.delete", { root, templateId });
}

export async function listAgentProfiles(root: string): Promise<AgentProfile[]> {
  if (!nativeRuntime) return demoAgentProfiles.map((profile) => ({
    ...profile,
    latestRun: demoAgentRuns.find((run) => run.agentProfileId === profile.id),
  }));
  return rpc<AgentProfile[]>("agent.list", { root });
}

export async function upsertAgentProfile(root: string, profile: Omit<AgentProfile, "latestRun">): Promise<AgentProfile> {
  if (!nativeRuntime) {
    const now = new Date().toISOString();
    const isNew = !demoAgentProfiles.some((item) => item.id === profile.id);
    const saved = { ...profile, createdAt: profile.createdAt || now, updatedAt: now };
    demoAgentProfiles = [...demoAgentProfiles.filter((item) => item.id !== saved.id), saved];
    if (isNew) demoAgentPrompts = [...demoAgentPrompts, { id: `prompt:${saved.id}:default`, agentProfileId: saved.id, name: "默认分析任务", content: "请分析当前研究上下文，提炼最重要且有证据支持的结论，并指出证据不足之处。", sortOrder: 0, createdAt: now, updatedAt: now }];
    return saved;
  }
  return rpc<AgentProfile>("agent.upsert", { root, ...profile });
}

export async function deleteAgentProfile(root: string, agentProfileId: string): Promise<void> {
  if (!nativeRuntime) {
    demoAgentProfiles = demoAgentProfiles.filter((item) => item.id !== agentProfileId);
    demoAgentPrompts = demoAgentPrompts.filter((item) => item.agentProfileId !== agentProfileId);
    return;
  }
  await rpc("agent.delete", { root, agentProfileId });
}

export async function listAgentPrompts(root: string, agentProfileId: string): Promise<AgentPromptTemplate[]> {
  if (!nativeRuntime) return demoAgentPrompts.filter((item) => item.agentProfileId === agentProfileId).sort((left, right) => left.sortOrder - right.sortOrder || right.updatedAt.localeCompare(left.updatedAt));
  return rpc<AgentPromptTemplate[]>("agent.prompt_list", { root, agentProfileId });
}

export async function upsertAgentPrompt(root: string, input: { id?: string; agentProfileId: string; name: string; content: string; sortOrder?: number }): Promise<AgentPromptTemplate> {
  if (!nativeRuntime) {
    const now = new Date().toISOString();
    const previous = demoAgentPrompts.find((item) => item.id === input.id);
    const saved: AgentPromptTemplate = { id: input.id ?? crypto.randomUUID(), agentProfileId: input.agentProfileId, name: input.name.trim(), content: input.content.trim(), sortOrder: input.sortOrder ?? previous?.sortOrder ?? 0, createdAt: previous?.createdAt ?? now, updatedAt: now };
    demoAgentPrompts = [...demoAgentPrompts.filter((item) => item.id !== saved.id), saved];
    return saved;
  }
  return rpc<AgentPromptTemplate>("agent.prompt_upsert", { root, ...input });
}

export async function deleteAgentPrompt(root: string, promptId: string): Promise<void> {
  if (!nativeRuntime) {
    demoAgentPrompts = demoAgentPrompts.filter((item) => item.id !== promptId);
    return;
  }
  await rpc("agent.prompt_delete", { root, promptId });
}

export async function listAgentRuns(root: string, agentProfileId?: string): Promise<AgentRun[]> {
  if (!nativeRuntime) return demoAgentRuns.filter((run) => !agentProfileId || run.agentProfileId === agentProfileId);
  return rpc<AgentRun[]>("agent.run_list", { root, agentProfileId, limit: 50 });
}

export async function startAgentRun(root: string, input: { agentProfileId: string; userPrompt: string; contextSnapshot: ContextSnapshot }): Promise<AgentRun> {
  if (!nativeRuntime) {
    const profile = demoAgentProfiles.find((item) => item.id === input.agentProfileId);
    if (!profile) throw new Error("Unknown agent profile.");
    const now = new Date().toISOString();
    const run: AgentRun = {
      id: crypto.randomUUID(),
      agentProfileId: profile.id,
      status: "running",
      providerId: profile.providerId,
      modelId: profile.modelId,
      promptVersion: profile.promptVersion,
      userPrompt: input.userPrompt,
      contextSnapshot: input.contextSnapshot,
      outputText: "",
      usage: { inputTokens: 0, outputTokens: 0, durationMs: 0 },
      cancelRequested: false,
      startedAt: now,
      createdAt: now,
      updatedAt: now,
      toolCalls: [],
    };
    demoAgentRuns = [run, ...demoAgentRuns];
    return run;
  }
  return rpc<AgentRun>("agent.run_start", { root, ...input });
}

export async function updateAgentRun(root: string, runId: string, input: { status: "running" | "completed" | "failed" | "cancelled"; outputText: string; inputTokens?: number; outputTokens?: number; durationMs?: number; error?: string }): Promise<AgentRun> {
  if (!nativeRuntime) {
    const index = demoAgentRuns.findIndex((run) => run.id === runId);
    if (index < 0) throw new Error("Unknown agent run.");
    const now = new Date().toISOString();
    const previous = demoAgentRuns[index];
    const updated: AgentRun = {
      ...previous,
      status: input.status,
      outputText: input.outputText,
      usage: {
        inputTokens: input.inputTokens ?? previous.usage.inputTokens,
        outputTokens: input.outputTokens ?? previous.usage.outputTokens,
        durationMs: input.durationMs ?? previous.usage.durationMs,
      },
      error: input.error,
      cancelRequested: input.status === "cancelled",
      finishedAt: input.status === "running" ? undefined : now,
      updatedAt: now,
    };
    demoAgentRuns = demoAgentRuns.map((run) => run.id === runId ? updated : run);
    return updated;
  }
  return rpc<AgentRun>("agent.run_update", { root, runId, ...input });
}

export async function cancelAgentRun(root: string, runId: string): Promise<AgentRun> {
  if (!nativeRuntime) return updateAgentRun(root, runId, { status: "cancelled", outputText: demoAgentRuns.find((run) => run.id === runId)?.outputText ?? "" });
  return rpc<AgentRun>("agent.run_cancel", { root, runId });
}

export async function retryAgentRun(root: string, runId: string): Promise<AgentRun> {
  if (!nativeRuntime) {
    const previous = demoAgentRuns.find((run) => run.id === runId);
    if (!previous) throw new Error("Unknown agent run.");
    const retried = await startAgentRun(root, {
      agentProfileId: previous.agentProfileId,
      userPrompt: previous.userPrompt,
      contextSnapshot: previous.contextSnapshot,
    });
    retried.retryOf = runId;
    return retried;
  }
  return rpc<AgentRun>("agent.run_retry", { root, runId });
}

const demoToolDefinitions: ModelToolDefinition[] = [
  { name: "search_library", description: "Search local paper titles.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "read_paper", description: "Read one local paper.", inputSchema: { type: "object", properties: { paperId: { type: "string" } }, required: ["paperId"] } },
  { name: "read_section", description: "Read one structured section.", inputSchema: { type: "object", properties: { paperId: { type: "string" }, sectionId: { type: "string" } }, required: ["paperId", "sectionId"] } },
  { name: "read_figure", description: "Read extracted figure metadata.", inputSchema: { type: "object", properties: { paperId: { type: "string" }, figureId: { type: "string" } }, required: ["paperId"] } },
  { name: "find_evidence", description: "Find grounded local evidence.", inputSchema: { type: "object", properties: { query: { type: "string" }, paperId: { type: "string" } }, required: ["query"] } },
  { name: "get_references", description: "Read structured references.", inputSchema: { type: "object", properties: { paperId: { type: "string" } }, required: ["paperId"] } },
];

export async function listAgentTools(root: string, agentProfileId: string): Promise<ModelToolDefinition[]> {
  if (!nativeRuntime) {
    const allowed = new Set(demoAgentProfiles.find((profile) => profile.id === agentProfileId)?.allowedTools ?? []);
    return demoToolDefinitions.filter((tool) => allowed.has(tool.name));
  }
  return rpc<ModelToolDefinition[]>("agent.tool_registry", { root, agentProfileId });
}

export async function executeAgentTool(root: string, input: { runId: string; toolCallId: string; toolName: string; arguments: Record<string, unknown>; iteration: number }): Promise<AgentToolCallRecord> {
  if (!nativeRuntime) {
    const run = demoAgentRuns.find((item) => item.id === input.runId);
    const profile = demoAgentProfiles.find((item) => item.id === run?.agentProfileId);
    if (!run || !profile) throw new Error("Unknown agent run.");
    const existing = run.toolCalls.find((item) => item.toolCallId === input.toolCallId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const allowed = profile.allowedTools.includes(input.toolName) && demoToolDefinitions.some((tool) => tool.name === input.toolName);
    const result = input.toolName === "find_evidence"
      ? [{ paperId: demoPapers[0]?.id, paperTitle: demoPapers[0]?.title, sectionId: "demo-section", snippet: "Local evidence preview for browser acceptance." }]
      : { ok: true, preview: true };
    const record: AgentToolCallRecord = {
      id: crypto.randomUUID(), runId: run.id, toolCallId: input.toolCallId, iteration: input.iteration,
      position: run.toolCalls.filter((item) => item.iteration === input.iteration).length + 1,
      toolName: input.toolName, arguments: input.arguments, status: allowed ? "completed" : "denied",
      result: allowed ? result : undefined, error: allowed ? undefined : `Tool ${input.toolName} is not allowed for this agent`,
      startedAt: now, finishedAt: now, createdAt: now, updatedAt: now,
    };
    run.toolCalls = [...run.toolCalls, record];
    return record;
  }
  return rpc<AgentToolCallRecord>("agent.tool_execute", { root, ...input });
}

let demoInnovationPrompt: InnovationPromptRevision | null = null;
let demoInnovationRuns: InnovationRun[] = [];
const innovationStageOrder: InnovationStageId[] = ["compression", "evidence", "ideas", "novelty", "critique"];

export async function getInnovationPrompt(root: string, promptVersion = "innovation-v1"): Promise<InnovationPromptRevision | null> {
  if (!nativeRuntime) return demoInnovationPrompt?.promptVersion === promptVersion ? demoInnovationPrompt : null;
  return rpc<InnovationPromptRevision | null>("innovation.prompt_get", { root, promptVersion });
}

export async function saveInnovationPrompt(root: string, promptText: string, promptVersion = "innovation-v1"): Promise<InnovationPromptRevision> {
  if (!nativeRuntime) {
    demoInnovationPrompt = {
      id: crypto.randomUUID(),
      promptText,
      promptVersion,
      revision: (demoInnovationPrompt?.revision ?? 0) + 1,
      createdAt: new Date().toISOString(),
    };
    return demoInnovationPrompt;
  }
  return rpc<InnovationPromptRevision>("innovation.prompt_save", { root, promptText, promptVersion });
}

export async function listInnovationRuns(root: string): Promise<InnovationRun[]> {
  if (!nativeRuntime) return demoInnovationRuns;
  return rpc<InnovationRun[]>("innovation.run_list", { root, limit: 30 });
}

export async function startInnovationRun(root: string, input: { promptText: string; promptVersion: string; contextSnapshot: ContextSnapshot; stageModels: Record<InnovationStageId, string> }): Promise<InnovationRun> {
  if (!nativeRuntime) {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const run: InnovationRun = {
      id,
      status: "running",
      currentStage: "compression",
      promptText: input.promptText,
      promptVersion: input.promptVersion,
      contextSnapshot: input.contextSnapshot,
      stageModels: input.stageModels,
      stages: innovationStageOrder.map((stage, position) => ({
        id: crypto.randomUUID(), runId: id, stage, position, status: "pending", modelId: input.stageModels[stage], attempt: 0,
        outputText: "", usage: { inputTokens: 0, outputTokens: 0, durationMs: 0 }, updatedAt: now,
      })),
      cancelRequested: false,
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    demoInnovationRuns = [run, ...demoInnovationRuns];
    return run;
  }
  return rpc<InnovationRun>("innovation.run_start", { root, ...input });
}

export async function startInnovationStage(root: string, runId: string, stage: InnovationStageId): Promise<void> {
  if (!nativeRuntime) {
    const run = demoInnovationRuns.find((item) => item.id === runId);
    const record = run?.stages.find((item) => item.stage === stage);
    if (run && record) {
      record.status = "running";
      record.attempt += 1;
      record.startedAt = new Date().toISOString();
      run.currentStage = stage;
      run.status = "running";
    }
    return;
  }
  await rpc("innovation.stage_start", { root, runId, stage });
}

export async function updateInnovationStage(root: string, runId: string, stage: InnovationStageId, input: { status: "running" | "completed" | "failed" | "cancelled"; outputText: string; inputTokens?: number; outputTokens?: number; durationMs?: number; error?: string }): Promise<InnovationRun> {
  if (!nativeRuntime) {
    const run = demoInnovationRuns.find((item) => item.id === runId);
    const record = run?.stages.find((item) => item.stage === stage);
    if (!run || !record) throw new Error("Unknown innovation stage.");
    const now = new Date().toISOString();
    record.status = input.status;
    record.outputText = input.outputText;
    record.usage = { inputTokens: input.inputTokens ?? record.usage.inputTokens, outputTokens: input.outputTokens ?? record.usage.outputTokens, durationMs: input.durationMs ?? record.usage.durationMs };
    record.error = input.error;
    record.updatedAt = now;
    if (input.status !== "running") record.finishedAt = now;
    if (input.status === "completed") {
      const next = innovationStageOrder[record.position + 1];
      if (next) run.currentStage = next;
      else { run.status = "completed"; run.finishedAt = now; }
    } else if (input.status === "failed" || input.status === "cancelled") {
      run.status = input.status;
      run.error = input.error;
      run.finishedAt = now;
    }
    run.updatedAt = now;
    return run;
  }
  return rpc<InnovationRun>("innovation.stage_update", { root, runId, stage, ...input });
}

export async function cancelInnovationRun(root: string, runId: string): Promise<InnovationRun> {
  if (!nativeRuntime) {
    const run = demoInnovationRuns.find((item) => item.id === runId);
    if (!run) throw new Error("Unknown innovation run.");
    return updateInnovationStage(root, runId, run.currentStage, { status: "cancelled", outputText: run.stages.find((stage) => stage.stage === run.currentStage)?.outputText ?? "", error: "Cancelled by user" });
  }
  return rpc<InnovationRun>("innovation.run_cancel", { root, runId });
}

export async function retryInnovationRun(root: string, runId: string): Promise<InnovationRun> {
  if (!nativeRuntime) {
    const run = demoInnovationRuns.find((item) => item.id === runId);
    if (!run) throw new Error("Unknown innovation run.");
    const resume = run.stages.find((stage) => stage.status !== "completed");
    if (!resume) throw new Error("No incomplete stage.");
    run.stages.filter((stage) => stage.position >= resume.position).forEach((stage) => { stage.status = "pending"; stage.outputText = ""; stage.error = undefined; });
    run.status = "running";
    run.currentStage = resume.stage;
    run.error = undefined;
    run.finishedAt = undefined;
    return run;
  }
  return rpc<InnovationRun>("innovation.run_retry", { root, runId });
}

export interface ModelStreamHandle {
  cancel: () => Promise<void>;
  dispose: () => void;
}

const modelActivityCancels = new Map<string, () => Promise<void>>();

export async function cancelModelActivity(requestId: string): Promise<void> {
  await modelActivityCancels.get(requestId)?.();
}

export async function startModelStream(input: ModelStreamRequest, onEvent: (event: ModelStreamEvent) => void, activity?: Partial<ModelActivityMeta>): Promise<ModelStreamHandle> {
  const safeInput = { ...input, provider: sanitizeProviderConfig(input.provider) };
  beginModelActivity(safeInput.requestId, {
    source: activity?.source ?? "model",
    label: activity?.label ?? "AI 模型调用",
    modelName: activity?.modelName ?? safeInput.model.displayName,
    groupKey: activity?.groupKey,
    totalItems: activity?.totalItems,
    deferCompletion: activity?.deferCompletion,
  });
  const emit = (event: ModelStreamEvent) => {
    applyModelStreamEvent(event);
    onEvent(event);
    if (["done", "tool_calls", "cancelled", "error"].includes(event.kind)) modelActivityCancels.delete(event.requestId);
  };
  if (!nativeRuntime) {
    emit({ requestId: safeInput.requestId, kind: "started" });
    emit({ requestId: safeInput.requestId, kind: "connected" });
    const tool = safeInput.messages.some((message) => message.role === "tool") ? undefined : safeInput.tools?.find((candidate) => candidate.name === "find_evidence");
    if (tool) {
      emit({ requestId: safeInput.requestId, kind: "tool_calls", toolCalls: [{ id: crypto.randomUUID(), name: tool.name, arguments: { query: "evidence" } }], usage: { inputTokens: 0, outputTokens: 0 } });
      return { cancel: async () => undefined, dispose: () => undefined };
    }
    const lastMessage = safeInput.messages.at(-1)?.content ?? "";
    let previewText = `Preview response: ${lastMessage}`;
    const structuredStart = lastMessage.lastIndexOf('{"segments":');
    if (structuredStart >= 0) {
      try {
        const structured = JSON.parse(lastMessage.slice(structuredStart)) as { segments?: Array<{ id?: string; sourceText?: string }> };
        previewText = JSON.stringify({
          segments: (structured.segments ?? []).map((segment, index) => ({ id: segment.id, translatedText: `结构化译文示例 ${index + 1}：${segment.sourceText ?? ""}` })),
          terms: [],
        });
      } catch {
        // Keep the generic preview response when the last message is not a translation payload.
      }
    }
    emit({ requestId: safeInput.requestId, kind: "delta", text: previewText });
    emit({ requestId: safeInput.requestId, kind: "done", usage: { inputTokens: 0, outputTokens: 0 } });
    return { cancel: async () => undefined, dispose: () => undefined };
  }
  const unlisten = await listen<ModelStreamEvent>("model-stream", (event) => {
    if (event.payload.requestId === safeInput.requestId) emit(event.payload);
  });
  try {
    await invoke("model_stream_start", { input: safeInput });
  } catch (error) {
    unlisten();
    failModelActivity(safeInput.requestId, error instanceof Error ? error.message : String(error));
    throw error;
  }
  const cancel = () => invoke<void>("model_stream_cancel", { requestId: safeInput.requestId });
  modelActivityCancels.set(safeInput.requestId, cancel);
  return {
    cancel,
    dispose: () => {
      modelActivityCancels.delete(safeInput.requestId);
      unlisten();
    },
  };
}

export async function onEngineProgress(
  callback: (notification: ProgressNotification) => void,
): Promise<() => void> {
  if (!nativeRuntime) return () => undefined;
  return listen<ProgressNotification>("engine-notification", (event) => callback(event.payload));
}

export interface JobRecord {
  id: string;
  paper_id?: string;
  status: string;
  progress: number;
  message: string;
  error?: string;
  created_at: string;
  updated_at: string;
  stages: JobStage[];
}

export async function listJobs(root: string): Promise<JobRecord[]> {
  if (!nativeRuntime) {
    return demoPapers.map((paper, index) => ({
      id: `demo-job-${index}`,
      paper_id: paper.id,
      status: paper.status,
      progress: paper.progress,
      message: paper.status === "READY" ? "Artifacts indexed" : paper.error ?? "Pipeline running",
      error: paper.error,
      created_at: paper.updatedAt,
      updated_at: paper.updatedAt,
      stages: ["hash", "layout", "ocr", "figures", "tables", "index"].map((stage, stageIndex) => ({
        id: `${index}-${stage}`,
        jobId: `demo-job-${index}`,
        stage: stage as JobStage["stage"],
        status: stageIndex / 6 < paper.progress ? "READY" : paper.status,
        progress: stageIndex / 6 < paper.progress ? 1 : 0,
        attempt: 1,
        artifact: {},
        updatedAt: paper.updatedAt,
      })),
    }));
  }
  return rpc<JobRecord[]>("job.list", { root });
}

export async function cancelJob(root: string, jobId: string): Promise<void> {
  if (!nativeRuntime) return;
  await rpc("job.cancel", { root, jobId });
}

export async function retryJob(root: string, jobId: string): Promise<void> {
  if (!nativeRuntime) return;
  await rpc("job.retry", { root, jobId });
}

export async function inspectZotero(dataDir?: string): Promise<ZoteroInspection> {
  if (!nativeRuntime) return {
    dataDir: "E:/Zotero/lib",
    databasePath: "E:/Zotero/lib/zotero.sqlite",
    locked: false,
    itemCount: 158,
    pdfCount: 54,
    missingPdfCount: 0,
    collections: [
      { id: 1, name: "FinFT" },
      { id: 2, name: "ICASSP-2026" },
      { id: 3, name: "多模态与会话情绪识别", parentId: 2 },
    ],
  };
  return rpc<ZoteroInspection>("zotero.inspect", dataDir ? { dataDir } : {});
}

export async function previewZoteroImport(dataDir?: string): Promise<ZoteroImportCandidate[]> {
  if (!nativeRuntime) {
    const categories = [
      ...Array(13).fill("finft"), ...Array(17).fill("multimodal"),
    ] as ZoteroImportCandidate["category"][];
    const pageCounts = [28, 10, 10, 6, 38, 7, 27, 31, 9, 6, 3, 8, 11, ...Array(17).fill(5)];
    return categories.map((category, index) => ({
      attachmentKey: `DEMO${String(index + 1).padStart(4, "0")}`,
      itemKey: `ITEM${index + 1}`,
      title: category === "finft" ? `Financial agent research paper ${index + 1}` : `Multimodal conversation study ${index + 1}`,
      authors: ["Local Zotero author"],
      year: 2024 + (index % 3),
      collections: category === "finft" ? ["FinFT"] : category === "unfiled" ? [] : [category === "icassp" ? "ICASSP-2026" : "多模态与会话情绪识别"],
      sourcePath: `E:/Zotero/lib/storage/DEMO${index + 1}/paper.pdf`,
      filename: `paper-${index + 1}.pdf`,
      sha256: String(index).padStart(64, "0"),
      pageCount: pageCounts[index],
      sizeBytes: 1_000_000 + index * 80_000,
      category,
      selected: true,
    }));
  }
  return rpc<ZoteroImportCandidate[]>("zotero.preview_import", dataDir ? { dataDir } : {});
}

export async function importFromZotero(root: string, dataDir: string, candidates: ZoteroImportCandidate[]): Promise<ZoteroImportResult> {
  if (!nativeRuntime) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    return {
      selected: candidates.filter((candidate) => candidate.selected).length,
      copied: candidates.filter((candidate) => candidate.selected).length,
      discovered: candidates.filter((candidate) => candidate.selected).length,
      deduplicated: 0,
      enqueued: candidates.filter((candidate) => candidate.selected).length,
      jobIds: [],
    };
  }
  return rpc<ZoteroImportResult>("zotero.import", { root, dataDir, candidates });
}

export interface OcrStatus {
  configured: boolean;
  consent: boolean;
  workspaceConfigured: boolean;
  workspaceRequired: boolean;
  model: string;
  baseUrl: string;
}

export async function getOcrStatus(): Promise<OcrStatus> {
  if (!nativeRuntime) {
    return {
      configured: true,
      consent: true,
      workspaceConfigured: false,
      workspaceRequired: false,
      model: "qwen3.5-ocr",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    };
  }
  return invoke<OcrStatus>("ocr_status");
}

export async function startLibraryWatcher(root: string): Promise<void> {
  if (!nativeRuntime) return;
  await invoke("watch_library", { root });
}

export async function uninstallApplication(): Promise<void> {
  if (!nativeRuntime) return;
  await invoke("uninstall_app");
}

export function assetUrl(path: string | undefined): string | undefined {
  if (!path || !nativeRuntime) return undefined;
  return convertFileSrc(path);
}
