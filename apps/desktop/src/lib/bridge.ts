import type { CitationGraphResult, CitationReference, ContextCompressionRecord, ContextDraft, ContextDraftItem, ContextLoadMode, ContextSourceItem, JobStage, LibraryPaper, ModelStreamEvent, ModelStreamRequest, PaperDocument, ProgressNotification, TranslationRecord, ZoteroImportCandidate, ZoteroImportResult, ZoteroInspection } from "@p2i/contracts";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { demoMarkdown, demoPapers } from "../demo";
import { sanitizeProviderConfig } from "./providerConfig";

export const nativeRuntime = isTauri();

async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return invoke<T>("rpc_call", { method, params });
}

export async function chooseLibrary(): Promise<string | null> {
  if (!nativeRuntime) return "D:/Research/Papers2Innovations-Library";
  return invoke<string | null>("choose_library");
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
  if (!nativeRuntime) return demoPapers;
  return rpc<LibraryPaper[]>("library.list", { root });
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

export async function readReferences(root: string, paperId: string): Promise<CitationReference[]> {
  if (!nativeRuntime) return [];
  return rpc<CitationReference[]>("paper.read_references", { root, paperId });
}

export async function buildCitationGraph(root: string, paperId: string, force = false): Promise<CitationGraphResult> {
  if (!nativeRuntime) {
    const paper = demoPapers.find((candidate) => candidate.id === paperId) ?? demoPapers[0];
    const direct = demoPapers.filter((candidate) => candidate.id !== paper.id).slice(0, 2);
    const nodes: CitationGraphResult["nodes"] = [
      { id: paper.id, paperId: paper.id, title: paper.title, authors: [], depth: 0, degree: direct.length, resolved: true, status: "ready" },
      ...direct.map((candidate, index) => ({ id: candidate.id, paperId: candidate.id, title: candidate.title, authors: [], depth: 1 as const, degree: 1, resolved: true, status: "ready" as const, year: 2025 + index })),
      { id: "demo-unresolved-reference", title: "Unresolved second-level scientific reference", authors: ["Local fixture"], depth: 2, degree: 1, resolved: false, status: "unresolved", year: 2024 },
    ];
    return {
      schemaVersion: 1,
      rootPaperId: paper.id,
      maxDepth: 2,
      status: "partial",
      nodes,
      edges: [
        ...direct.map((candidate) => ({ id: `cites:${paper.id}:${candidate.id}`, source: paper.id, target: candidate.id, relation: "cites" as const, weight: 1 })),
        { id: `cites:${direct[0]?.id}:demo-unresolved-reference`, source: direct[0]?.id ?? paper.id, target: "demo-unresolved-reference", relation: "cites", weight: 1 },
      ],
      directCount: direct.length,
      secondLevelCount: 1,
      unresolvedCount: 1,
      warnings: ["One second-level reference is unresolved in the browser fixture."],
      libraryFingerprint: "demo-library",
      generatedAt: new Date().toISOString(),
      cacheHit: false,
    };
  }
  return rpc<CitationGraphResult>("graph.build", { root, paperId, maxDepth: 2, force });
}

export async function listTranslations(root: string, paperId: string): Promise<TranslationRecord[]> {
  if (!nativeRuntime) return [];
  return rpc<TranslationRecord[]>("translation.list", { root, paperId });
}

export async function saveTranslation(root: string, input: Omit<TranslationRecord, "id" | "sourceHash" | "revision" | "createdAt" | "updatedAt">): Promise<TranslationRecord> {
  if (!nativeRuntime) {
    const now = new Date().toISOString();
    return { ...input, id: crypto.randomUUID(), sourceHash: "demo-source-hash", revision: 1, createdAt: now, updatedAt: now };
  }
  return rpc<TranslationRecord>("translation.save", { root, ...input });
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

export async function getContextDraft(root: string): Promise<ContextDraft> {
  if (!nativeRuntime) return demoContextDraft();
  return rpc<ContextDraft>("context.get", { root });
}

export async function addPaperToContext(root: string, paperId: string, mode: Extract<ContextLoadMode, "full" | "structured"> = "full"): Promise<ContextDraft> {
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
  return rpc<ContextDraft>("context.add_paper", { root, paperId, mode });
}

export async function addSelectionToContext(root: string, input: { paperId: string; sectionId: string; blockId?: string; sourceText: string }): Promise<ContextDraft> {
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

export async function readContextItem(root: string, itemId: string): Promise<ContextSourceItem> {
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
  return rpc<ContextSourceItem>("context.read_item", { root, itemId });
}

export async function getContextCompression(root: string, itemId: string, modelId: string, promptVersion: string): Promise<ContextCompressionRecord | null> {
  if (!nativeRuntime) return demoContextCompressions.get(demoCompressionKey(itemId, modelId, promptVersion)) ?? null;
  return rpc<ContextCompressionRecord | null>("context.get_compression", { root, itemId, modelId, promptVersion });
}

export async function activateContextCompression(root: string, itemId: string, modelId: string, promptVersion: string): Promise<ContextDraft> {
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
  return rpc<ContextDraft>("context.activate_compression", { root, itemId, modelId, promptVersion });
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

export async function removePaperFromContext(root: string, paperId: string): Promise<ContextDraft> {
  if (!nativeRuntime) {
    demoContextItems = demoContextItems.filter((item) => item.paperId !== paperId);
    return demoContextDraft();
  }
  return rpc<ContextDraft>("context.remove_paper", { root, paperId });
}

export async function clearContext(root: string): Promise<ContextDraft> {
  if (!nativeRuntime) {
    demoContextItems = [];
    return demoContextDraft();
  }
  return rpc<ContextDraft>("context.clear", { root });
}

export interface ModelStreamHandle {
  cancel: () => Promise<void>;
  dispose: () => void;
}

export async function startModelStream(input: ModelStreamRequest, onEvent: (event: ModelStreamEvent) => void): Promise<ModelStreamHandle> {
  const safeInput = { ...input, provider: sanitizeProviderConfig(input.provider) };
  if (!nativeRuntime) {
    onEvent({ requestId: safeInput.requestId, kind: "started" });
    onEvent({ requestId: safeInput.requestId, kind: "delta", text: `Preview translation: ${safeInput.messages.at(-1)?.content ?? ""}` });
    onEvent({ requestId: safeInput.requestId, kind: "done", usage: { inputTokens: 0, outputTokens: 0 } });
    return { cancel: async () => undefined, dispose: () => undefined };
  }
  const unlisten = await listen<ModelStreamEvent>("model-stream", (event) => {
    if (event.payload.requestId === safeInput.requestId) onEvent(event.payload);
  });
  try {
    await invoke("model_stream_start", { input: safeInput });
  } catch (error) {
    unlisten();
    throw error;
  }
  return {
    cancel: () => invoke<void>("model_stream_cancel", { requestId: safeInput.requestId }),
    dispose: unlisten,
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

export async function inspectZotero(): Promise<ZoteroInspection> {
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
  return rpc<ZoteroInspection>("zotero.inspect");
}

export async function previewZoteroImport(): Promise<ZoteroImportCandidate[]> {
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
  return rpc<ZoteroImportCandidate[]>("zotero.preview_import");
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
