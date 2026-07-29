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

export interface MarkdownFormattingInfo {
  model_id: string;
  prompt_version: string;
  source_sha256: string;
  updated_at: string;
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
  formatting?: MarkdownFormattingInfo;
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
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ModelToolCall[];
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelStreamRequest {
  requestId: string;
  provider: ProviderConfig;
  model: ModelConfig;
  messages: ModelMessage[];
  tools?: ModelToolDefinition[];
  temperature?: number;
}

export interface ModelStreamEvent {
  requestId: string;
  kind: "started" | "delta" | "tool_calls" | "done" | "cancelled" | "error";
  text?: string;
  toolCalls?: ModelToolCall[];
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
  sourceStart: number;
  sourceEnd: number;
  segments: TranslationSegment[];
  terms: TranslationTerm[];
  targetLanguage: string;
  modelId: string;
  promptVersion: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface TranslationSegment {
  id: string;
  sourceStart: number;
  sourceEnd: number;
  sourceText: string;
  translatedText: string;
}

export interface TranslationTerm {
  text: string;
  translation: string;
  explanation: string;
  kind: "phrase" | "term";
  segmentId?: string;
  sourceStart?: number;
  sourceEnd?: number;
  literalMeaning?: string;
  contextMeaning?: string;
}

export type ReaderAnnotationTarget = "translation" | "chat_turn" | "analysis" | "conversation";

export interface ReaderAnnotation {
  id: string;
  paperId: string;
  sectionId: string;
  blockId: string;
  sourceHash: string;
  sourceStart: number;
  sourceEnd: number;
  annotationType: "translation" | "chat";
  targetType: ReaderAnnotationTarget;
  relatedId?: string;
  selectedText: string;
  anchorHash: string;
  createdAt: string;
  updatedAt: string;
}

export type ReaderAnalysisType = "formula" | "theorem";

export interface ReaderAnalysisRecord {
  id: string;
  paperId: string;
  sectionId: string;
  blockId: string;
  analysisType: ReaderAnalysisType;
  sourceHash: string;
  sourceText: string;
  adjacentContext: string;
  resultText: string;
  modelId: string;
  promptVersion: string;
  revision: number;
  usage: { inputTokens: number; outputTokens: number; durationMs: number };
  createdAt: string;
  updatedAt: string;
}

export interface ReaderChatResponse {
  id: string;
  assistantText: string;
  modelId: string;
  promptVersion: string;
  revision: number;
  status: "completed" | "cancelled" | "failed";
  usage: { inputTokens: number; outputTokens: number; durationMs: number };
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReaderChatTurn {
  id: string;
  turnIndex: number;
  userMessage: string;
  contextSnapshot: ContextSnapshot;
  response?: ReaderChatResponse;
  revisions: ReaderChatTurnRevision[];
  createdAt: string;
}

export interface ReaderChatTurnRevision {
  id: string;
  turnId: string;
  userMessage: string;
  contextSnapshot: ContextSnapshot;
  revision: number;
  createdAt: string;
}

export interface ReaderConversation {
  id: string;
  paperId: string;
  turns: ReaderChatTurn[];
  createdAt?: string;
  updatedAt?: string;
}

export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  color: string;
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
  systemPrompt: string;
  promptVersion: string;
  createdAt: string;
  updatedAt: string;
  latestRun?: AgentRun;
}

export interface AgentPromptTemplate {
  id: string;
  agentProfileId: string;
  name: string;
  content: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export type PromptTemplateCategory = "reader" | "translation" | "explanation" | "markdown" | "innovation";

export interface PromptTemplate {
  id: string;
  category: PromptTemplateCategory;
  name: string;
  content: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export type AgentRunStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface AgentRun {
  id: string;
  agentProfileId: string;
  retryOf?: string;
  status: AgentRunStatus;
  providerId: string;
  modelId: string;
  promptVersion: string;
  userPrompt: string;
  contextSnapshot: ContextSnapshot;
  outputText: string;
  usage: { inputTokens: number; outputTokens: number; durationMs: number };
  error?: string;
  cancelRequested: boolean;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
  toolCalls: AgentToolCallRecord[];
}

export interface AgentToolCallRecord {
  id: string;
  runId: string;
  toolCallId: string;
  iteration: number;
  position: number;
  toolName: string;
  arguments: Record<string, unknown>;
  status: "running" | "completed" | "failed" | "denied";
  result?: unknown;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type InnovationStageId = "compression" | "evidence" | "ideas" | "novelty" | "critique";
export type InnovationRunStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type InnovationStageStatus = "pending" | InnovationRunStatus;

export interface InnovationPromptRevision {
  id: string;
  promptText: string;
  promptVersion: string;
  revision: number;
  createdAt: string;
}

export interface InnovationStageRecord {
  id: string;
  runId: string;
  stage: InnovationStageId;
  position: number;
  status: InnovationStageStatus;
  modelId: string;
  attempt: number;
  outputText: string;
  usage: { inputTokens: number; outputTokens: number; durationMs: number };
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

export interface InnovationRun {
  id: string;
  retryOf?: string;
  status: InnovationRunStatus;
  currentStage: InnovationStageId;
  promptText: string;
  promptVersion: string;
  contextSnapshot: ContextSnapshot;
  stageModels: Record<InnovationStageId, string>;
  stages: InnovationStageRecord[];
  cancelRequested: boolean;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type ContextLoadMode = "full" | "structured" | "compressed" | "retrieval" | "sections";
export type ContextScopeType = "paper" | "research";
export type ScopedContextItemType = "markdown" | "compressed_markdown" | "custom";

export interface ContextScope {
  id: string;
  scopeType: ContextScopeType;
  paperId?: string;
  name: string;
}

export interface ContextCompressionSummary {
  id: string;
  modelId: string;
  promptVersion: string;
  revision: number;
  estimatedTokens: number;
  usage: { inputTokens: number; outputTokens: number; durationMs: number };
  preview: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContextCompressionRecord extends ContextCompressionSummary {
  itemId: string;
  sourceHash: string;
  compressedText: string;
}

export interface ContextSourceItem {
  id: string;
  paperId: string;
  paperTitle: string;
  sectionId?: string;
  blockId?: string;
  sourceHash: string;
  sourceText: string;
  estimatedTokens: number;
}

export interface ContextDraftItem {
  id: string;
  paperId: string;
  paperTitle: string;
  sectionId?: string;
  blockId?: string;
  mode: ContextLoadMode;
  scopeId?: string;
  itemType?: ScopedContextItemType;
  title?: string;
  sourceHash: string;
  sourcePreview: string;
  estimatedTokens: number;
  compression?: ContextCompressionSummary;
  createdAt: string;
  updatedAt: string;
}

export interface ScopedContextItem extends ContextSourceItem {
  scopeId: string;
  itemType: ScopedContextItemType;
  title: string;
  customText?: string;
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
  scope?: ContextScope;
  items: ContextDraftItem[];
  tokenBreakdown: ContextTokenBreakdown;
  updatedAt?: string;
}

export interface FormulaRepair {
  id: string;
  paperId: string;
  sectionId: string;
  blockId: string;
  page?: number;
  originalText: string;
  repairedLatex: string;
  confidence: number;
  modelId: string;
  promptVersion: string;
}

export interface FigureAnalysis {
  id: string;
  paperId: string;
  figureId: string;
  status: "pending" | "completed" | "failed";
  description: string;
  modelId: string;
  promptVersion: string;
  usage: { inputTokens: number; outputTokens: number; durationMs: number };
  error?: string;
  updatedAt: string;
}

export interface PreprocessQualityReport {
  paperId: string;
  sourceHash: string;
  formulaIssueCount: number;
  repairedFormulaCount: number;
  figureCount: number;
  analyzedFigureCount: number;
  failedFigureCount: number;
  warnings: string[];
  updatedAt: string;
}

export interface ContextSnapshot {
  id: string;
  agentProfileId: string;
  modelId: string;
  reasoningEffort?: string;
  items: Array<{
    contextItemId?: string;
    paperId: string;
    sourceHash?: string;
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

export interface CitationReference {
  id: string;
  index: number;
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  doi?: string;
  arxiv?: string;
  rawCitation: string;
  resolvedPaperId?: string;
}

export type CitationRelation = "cites" | "shared_reference" | "coauthor" | "topic_similarity" | "mutual_citation";

export interface CitationGraphNode {
  id: string;
  paperId?: string;
  title: string;
  authors: string[];
  year?: number;
  depth: 0 | 1 | 2;
  degree: number;
  resolved: boolean;
  status: "ready" | "unresolved" | "partial" | "error";
  doi?: string;
  arxiv?: string;
  rawCitation?: string;
}

export interface CitationGraphEdge {
  id: string;
  source: string;
  target: string;
  relation: CitationRelation;
  weight: number;
}

export interface CitationGraphResult {
  schemaVersion: 1;
  rootPaperId: string;
  maxDepth: 1 | 2;
  status: "ready" | "partial" | "error";
  nodes: CitationGraphNode[];
  edges: CitationGraphEdge[];
  directCount: number;
  secondLevelCount: number;
  unresolvedCount: number;
  warnings: string[];
  libraryFingerprint: string;
  generatedAt: string;
  cacheHit: boolean;
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
  collectionIds: string[];
}

export interface LibraryCollection {
  id: string;
  name: string;
  parentId?: string;
  color: string;
  sortOrder: number;
  paperCount: number;
  createdAt: string;
  updatedAt: string;
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
