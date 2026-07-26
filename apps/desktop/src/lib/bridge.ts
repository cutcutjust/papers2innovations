import type { JobStage, LibraryPaper, ProgressNotification, ZoteroImportCandidate, ZoteroInspection } from "@p2i/contracts";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { demoMarkdown, demoPapers } from "../demo";

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

export async function importFromZotero(root: string, candidates: ZoteroImportCandidate[]): Promise<void> {
  if (!nativeRuntime) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    return;
  }
  await rpc("zotero.import", { root, candidates });
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
