export const jobStatuses = [
  "DISCOVERED",
  "HASHING",
  "QUEUED",
  "PARSING_LAYOUT",
  "EXTRACTING_FIGURES",
  "PARSING_REFERENCES",
  "RESOLVING_METADATA",
  "INDEXING",
  "GENERATING_RESEARCH_CARD",
  "READY",
  "PARTIAL",
  "FAILED",
  "MISSING",
  "CANCELLED",
] as const;

export type JobStatus = (typeof jobStatuses)[number];

export interface BoundingBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PageBBox extends BoundingBox {
  coordinateSpace: "normalized-top-left";
  pageWidth: number;
  pageHeight: number;
}

export interface EvidenceAnchor {
  paper_id: string;
  section_id: string;
  block_id: string;
  page: number;
  bbox?: BoundingBox;
  source_text: string;
}

export interface PaperSection {
  id: string;
  title: string;
  level: number;
  order: number;
  page_start?: number;
  page_end?: number;
  markdown: string;
  anchors: EvidenceAnchor[];
}

export interface PaperDocumentFigure {
  id: string;
  caption?: string;
  relative_path: string;
  page?: number;
  bbox?: BoundingBox;
  mime_type: string;
}

export interface PaperDocument {
  schema_version: "1.0";
  paper_id: string;
  source_sha256: string;
  title: string;
  authors: string[];
  abstract?: string;
  language?: string;
  page_count: number;
  sections: PaperSection[];
  figures: PaperDocumentFigure[];
  tables: Array<{ id: string; caption?: string; markdown: string; page?: number }>;
  parser: { name: string; version: string };
  generated_at: string;
}

export interface LibraryFigure {
  id: string;
  caption?: string;
  relativePath: string;
  page?: number;
  mimeType: string;
  thumbnailPath?: string;
  bbox?: PageBBox;
}

export interface ZoteroImportCandidate {
  attachmentKey: string;
  itemKey: string;
  title: string;
  authors: string[];
  year?: number;
  doi?: string;
  collections: string[];
  sourcePath: string;
  filename: string;
  sha256: string;
  pageCount: number;
  sizeBytes: number;
  category: "finft" | "multimodal" | "icassp" | "unfiled";
  selected: boolean;
}

export interface ZoteroInspection {
  dataDir: string;
  databasePath: string;
  locked: boolean;
  lockReason?: string;
  itemCount: number;
  pdfCount: number;
  missingPdfCount: number;
  collections: Array<{ id: number; name: string; parentId?: number }>;
}

export interface ZoteroImportResult {
  selected: number;
  copied: number;
  discovered: number;
  deduplicated: number;
  enqueued: number;
  jobIds: string[];
}

export interface PaperSource {
  id: string;
  paperId: string;
  sourceType: "zotero";
  itemKey: string;
  attachmentKey: string;
  collection?: string;
  sourceModifiedAt?: string;
  importedAt: string;
}

export type PipelineStage = "hash" | "layout" | "ocr" | "figures" | "tables" | "index";

export interface JobStage {
  id: string;
  jobId: string;
  stage: PipelineStage;
  status: JobStatus;
  progress: number;
  attempt: number;
  artifact: Record<string, unknown>;
  error?: string;
  updatedAt: string;
}

export interface OcrUsage {
  provider: "qwen";
  model: string;
  pageCount: number;
  cacheHits: number;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  failedPages: number[];
}

export interface ParseArtifactBundle {
  markdownPath: string;
  documentPath: string;
  metadataPath: string;
  referencesPath: string;
  figures: LibraryFigure[];
  tables: Array<{ id: string; caption?: string; markdownPath?: string; csvPath?: string; page?: number; bbox?: PageBBox }>;
  ocr?: OcrUsage;
  partial: boolean;
  warnings: string[];
}

export type ApiFormat = "openai" | "anthropic";

export interface ProviderConfig {
  id: string;
  name: string;
  format: ApiFormat;
  baseUrl: string;
  credentialId: string;
  headers?: Record<string, string>;
  timeoutSeconds: number;
}

export interface ModelConfig {
  id: string;
  providerId: string;
  model: string;
  displayName: string;
  maxContextTokens: number;
  maxOutputTokens: number;
}

export interface CredentialSummary {
  credentialId: string;
  configured: boolean;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelStreamRequest {
  requestId: string;
  provider: ProviderConfig;
  model: ModelConfig;
  messages: ModelMessage[];
  temperature?: number;
}

export interface ModelStreamEvent {
  requestId: string;
  kind: "started" | "delta" | "done" | "cancelled" | "error";
  text?: string;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface TranslationRecord {
  id: string;
  paperId: string;
  sectionId: string;
  blockId: string;
  sourceHash: string;
  sourceText: string;
  translatedText: string;
  targetLanguage: string;
  modelId: string;
  promptVersion: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentProfile {
  id: string;
  name: string;
  enabled: boolean;
  providerId: string;
  modelId: string;
  credentialId: string;
  maxContextTokens: number;
  maxOutputTokens: number;
  contextSafetyRatio: number;
  temperature: number;
  reasoningEffort?: string;
  timeoutSeconds: number;
  maxRetries: number;
  maxCostPerRun?: number;
  maxCostPerDay?: number;
  allowedTools: string[];
  networkPolicy: "none" | "academic" | "full";
  writePolicy: "read-only" | "confirm-write" | "trusted-write";
  systemPromptId: string;
  promptVersion: string;
}

export type ContextLoadMode = "full" | "structured" | "retrieval" | "sections";

export interface ContextDraftItem {
  id: string;
  paperId: string;
  paperTitle: string;
  sectionId?: string;
  blockId?: string;
  mode: ContextLoadMode;
  sourceHash: string;
  sourcePreview: string;
  estimatedTokens: number;
  createdAt: string;
  updatedAt: string;
}

export interface ContextTokenBreakdown {
  systemPrompt: number;
  tools: number;
  conversation: number;
  papers: number;
  figures: number;
  outputReserve: number;
  safetyBuffer: number;
}

export interface ContextDraft {
  items: ContextDraftItem[];
  tokenBreakdown: ContextTokenBreakdown;
  updatedAt?: string;
}

export interface ContextSnapshot {
  id: string;
  agentProfileId: string;
  modelId: string;
  reasoningEffort?: string;
  items: Array<{
    paperId: string;
    mode: ContextLoadMode;
    sectionIds: string[];
    figureIds: string[];
    estimatedTokens: number;
  }>;
  tokenBreakdown: ContextTokenBreakdown;
  promptVersion: string;
  toolVersions: Record<string, string>;
  retrievalQueries: string[];
  externalResults: Array<{ source: string; id: string; title: string }>;
  createdAt: string;
}

export interface LibraryPaper {
  id: string;
  title: string;
  sourcePath: string;
  status: JobStatus;
  progress: number;
  pageCount: number;
  markdownPath?: string;
  documentPath?: string;
  figures: LibraryFigure[];
  updatedAt: string;
  error?: string;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export interface ProgressNotification {
  jsonrpc: "2.0";
  method: "job.progress";
  params: {
    requestId?: string | number;
    jobId: string;
    paperId?: string;
    status: JobStatus;
    progress: number;
    message: string;
  };
}
