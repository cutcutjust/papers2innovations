import type { AgentProfile, AgentPromptTemplate, AgentRun, AgentToolCallRecord, CitationGraphResult, CitationReference, ContextCompressionRecord, ContextDraft, ContextDraftItem, ContextLoadMode, ContextSnapshot, ContextSourceItem, InnovationPromptRevision, InnovationRun, InnovationStageId, JobStage, LibraryCollection, LibraryPaper, ModelStreamEvent, ModelStreamRequest, ModelToolDefinition, PaperDocument, ProgressNotification, ReaderAnalysisRecord, ReaderAnalysisType, ReaderChatTurn, ReaderConversation, TranslationRecord, ZoteroImportCandidate, ZoteroImportResult, ZoteroInspection } from "@p2i/contracts";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { demoMarkdown, demoPapers } from "../demo";
import { sanitizeProviderConfig } from "./providerConfig";

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

export interface PdfImportResult {
  selected: number;
  copied: number;
  deduplicated: number;
  destination: string;
}

export async function importPdfs(root: string): Promise<PdfImportResult> {
  if (!nativeRuntime) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return { selected: 2, copied: 2, deduplicated: 0, destination: `${root}/Papers/Manual` };
  }
  return invoke<PdfImportResult>("import_pdfs", { root });
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
    return record;
  }
  return rpc<ReaderAnalysisRecord>("reader.analysis_save", { root, ...input });
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
      userMessage: existing?.userMessage ?? input.userMessage,
      contextSnapshot: existing?.contextSnapshot ?? input.contextSnapshot,
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

export async function startModelStream(input: ModelStreamRequest, onEvent: (event: ModelStreamEvent) => void): Promise<ModelStreamHandle> {
  const safeInput = { ...input, provider: sanitizeProviderConfig(input.provider) };
  if (!nativeRuntime) {
    onEvent({ requestId: safeInput.requestId, kind: "started" });
    const tool = safeInput.messages.some((message) => message.role === "tool") ? undefined : safeInput.tools?.find((candidate) => candidate.name === "find_evidence");
    if (tool) {
      onEvent({ requestId: safeInput.requestId, kind: "tool_calls", toolCalls: [{ id: crypto.randomUUID(), name: tool.name, arguments: { query: "evidence" } }], usage: { inputTokens: 0, outputTokens: 0 } });
      return { cancel: async () => undefined, dispose: () => undefined };
    }
    onEvent({ requestId: safeInput.requestId, kind: "delta", text: `Preview response: ${safeInput.messages.at(-1)?.content ?? ""}` });
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
