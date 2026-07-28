import type { ContextSnapshot, LibraryPaper, ModelStreamEvent, ReaderAnalysisRecord, ReaderAnalysisType, ReaderChatTurn, TranslationRecord } from "@p2i/contracts";
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Bot, Check, ChevronLeft, FileImage, FileText, Languages, Layers3, LoaderCircle, MessageSquareText, RefreshCw, Search, Send, Sparkles, Square, Trash2, TriangleAlert, WandSparkles, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { addPaperToContext, addSelectionToContext, assetUrl, clearReaderConversation, getContextCompression, getContextDraft, getReaderConversation, listReaderAnalyses, listTranslations, nativeRuntime, readContextItem, readDocument, readMarkdown, removePaperFromContext, saveFormattedDocument, saveReaderAnalysis, saveReaderChatTurn, saveTranslation, startModelStream, type ModelStreamHandle } from "../lib/bridge";
import { hydrateProviderCredentials } from "../lib/credentials";
import { buildReaderSections, type ReaderDisplaySection, type ReaderDocumentBlock } from "../lib/documentBlocks";
import { MARKDOWN_FORMAT_PROMPT_VERSION, prepareMarkdownForFormatting, restoreFormattedMarkdown, splitMarkdownForFormatting } from "../lib/markdownFormatting";
import { useWorkspace } from "../store";

type ReaderMode = "integrated" | "pdf" | "figures";
type ReaderBlock = ReaderDocumentBlock;
type ReaderSection = ReaderDisplaySection;
type SelectionSource = ReaderBlock & { start: number; end: number; left: number; top: number; placement: "above" | "below" };
type TranslationState = {
  status: "streaming" | "unsaved" | "saved" | "cancelled" | "error";
  text: string;
  error?: string;
  record?: TranslationRecord;
};
type AnalysisState = {
  status: "streaming" | "unsaved" | "saved" | "cancelled" | "error";
  text: string;
  adjacentContext: string;
  usage: { inputTokens: number; outputTokens: number; durationMs: number };
  error?: string;
  record?: ReaderAnalysisRecord;
};

const TRANSLATION_PROMPT_VERSION = "reader-translate-v1";
const ANALYSIS_PROMPT_VERSION = "reader-analysis-v1";
const CHAT_PROMPT_VERSION = "reader-chat-v1";
const analysisKey = (blockId: string, type: ReaderAnalysisType) => `${blockId}:${type}`;

function MarkdownBlock({ value }: { value: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{value}</ReactMarkdown>;
}

export function Reader({ paper, root }: { paper?: LibraryPaper; root: string }) {
  const { setView, customModels, providers, markdownFormattingModelId, autoFormatMarkdown } = useWorkspace();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<ReaderMode>("integrated");
  const [selection, setSelection] = useState<SelectionSource | null>(null);
  const [translations, setTranslations] = useState<Record<string, TranslationState>>({});
  const [analysisStates, setAnalysisStates] = useState<Record<string, AnalysisState>>({});
  const [activeAnalysis, setActiveAnalysis] = useState<{ blockId: string; type: ReaderAnalysisType } | null>(null);
  const [activeBlock, setActiveBlock] = useState("");
  const [activeSection, setActiveSection] = useState("");
  const [contextBusy, setContextBusy] = useState("");
  const [agentModel, setAgentModel] = useState(customModels[0]?.id ?? "");
  const [chatInput, setChatInput] = useState("");
  const [chatLive, setChatLive] = useState("");
  const [chatPendingQuestion, setChatPendingQuestion] = useState("");
  const [chatStatus, setChatStatus] = useState<"idle" | "streaming" | "error">("idle");
  const [chatError, setChatError] = useState("");
  const [agentOpen, setAgentOpen] = useState(false);
  const [formattingStatus, setFormattingStatus] = useState<"idle" | "formatting" | "saved" | "error">("idle");
  const [formattingProgress, setFormattingProgress] = useState(0);
  const [formattingError, setFormattingError] = useState("");
  const streamHandles = useRef(new Map<string, ModelStreamHandle>());
  const chatHandle = useRef<ModelStreamHandle | null>(null);
  const formattingHandle = useRef<ModelStreamHandle | null>(null);
  const autoFormattingKey = useRef("");
  const selectionToolbar = useRef<HTMLDivElement | null>(null);
  const readerCanvas = useRef<HTMLElement | null>(null);
  const readable = Boolean(paper?.id && paper && ["READY", "PARTIAL"].includes(paper.status));
  const markdownQuery = useQuery({
    queryKey: ["paper-markdown", root, paper?.id],
    queryFn: () => readMarkdown(root, paper!.id),
    enabled: readable,
  });
  const documentQuery = useQuery({
    queryKey: ["paper-document", root, paper?.id],
    queryFn: () => readDocument(root, paper!.id),
    enabled: readable,
    retry: false,
  });
  const translationQuery = useQuery({
    queryKey: ["paper-translations", root, paper?.id],
    queryFn: () => listTranslations(root, paper!.id),
    enabled: readable,
    retry: false,
  });
  const analysisQuery = useQuery({
    queryKey: ["reader-analyses", root, paper?.id],
    queryFn: () => listReaderAnalyses(root, paper!.id),
    enabled: readable,
    retry: false,
  });
  const chatQuery = useQuery({
    queryKey: ["reader-chat", root, paper?.id],
    queryFn: () => getReaderConversation(root, paper!.id),
    enabled: readable,
    retry: false,
  });
  const providerCredentialQuery = useQuery({
    queryKey: ["provider-credentials", providers.map((provider) => provider.credentialId).sort().join(":")],
    queryFn: () => hydrateProviderCredentials(providers),
    retry: false,
  });
  const contextDraftQuery = useQuery({
    queryKey: ["context-draft", root],
    queryFn: () => getContextDraft(root),
    retry: false,
  });
  const sections = useMemo(
    () => buildReaderSections(documentQuery.data, markdownQuery.data ?? ""),
    [documentQuery.data, markdownQuery.data],
  );
  const persistedTranslations = useMemo(
    () => Object.fromEntries((translationQuery.data ?? []).map((record) => [record.blockId, { status: "saved", text: record.translatedText, record } satisfies TranslationState])),
    [translationQuery.data],
  );
  const persistedAnalyses = useMemo(
    () => Object.fromEntries((analysisQuery.data ?? []).map((record) => [analysisKey(record.blockId, record.analysisType), {
      status: "saved",
      text: record.resultText,
      adjacentContext: record.adjacentContext,
      usage: record.usage,
      record,
    } satisfies AnalysisState])),
    [analysisQuery.data],
  );
  const selectedModel = customModels.find((model) => model.id === agentModel) ?? customModels[0];
  const selectedProvider = providers.find((provider) => provider.id === selectedModel?.providerId);
  const formattingModel = customModels.find((model) => model.id === markdownFormattingModelId) ?? customModels[0];
  const formattingProvider = providers.find((provider) => provider.id === formattingModel?.providerId);
  const maxContextTokens = selectedModel?.maxContextTokens ?? 128000;
  const tokenBreakdown = contextDraftQuery.data?.tokenBreakdown;
  const contextUsed = tokenBreakdown ? Object.values(tokenBreakdown).reduce((total, value) => total + value, 0) : 36000;
  const contextPercent = Math.min(100, Math.round(contextUsed / maxContextTokens * 100));
  const fullText = Boolean(paper && contextDraftQuery.data?.items.some(
    (item) => item.paperId === paper.id && !item.sectionId && !item.blockId,
  ));
  const formattingCredentialReady = !nativeRuntime || Boolean(formattingProvider && providerCredentialQuery.data?.some(
    (summary) => summary.credentialId === formattingProvider.credentialId && summary.configured,
  ));

  useEffect(() => {
    setTranslations({});
    setAnalysisStates({});
    setSelection(null);
    setActiveBlock("");
    setActiveSection("");
    setActiveAnalysis(null);
    setChatInput("");
    setChatLive("");
    setChatPendingQuestion("");
    setChatStatus("idle");
    setChatError("");
    setAgentOpen(false);
    setFormattingStatus("idle");
    setFormattingProgress(0);
    setFormattingError("");
    autoFormattingKey.current = "";
    for (const handle of streamHandles.current.values()) void handle.cancel();
    streamHandles.current.clear();
    if (chatHandle.current) {
      void chatHandle.current.cancel();
      chatHandle.current.dispose();
      chatHandle.current = null;
    }
    if (formattingHandle.current) {
      void formattingHandle.current.cancel();
      formattingHandle.current.dispose();
      formattingHandle.current = null;
    }
  }, [paper?.id]);

  useEffect(() => {
    if (mode !== "integrated" || !sections.length) return;
    setActiveSection((current) => current || sections[0].id);
    const root = readerCanvas.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top);
      if (visible[0]) setActiveSection(visible[0].target.getAttribute("data-section-id") ?? "");
    }, { root, rootMargin: "-10% 0px -72% 0px", threshold: [0, 0.05] });
    root.querySelectorAll<HTMLElement>("[data-section-id]").forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [mode, sections]);

  useEffect(() => () => {
    for (const handle of streamHandles.current.values()) {
      handle.dispose();
      void handle.cancel();
    }
    if (chatHandle.current) {
      chatHandle.current.dispose();
      void chatHandle.current.cancel();
    }
    if (formattingHandle.current) {
      formattingHandle.current.dispose();
      void formattingHandle.current.cancel();
    }
  }, []);

  useEffect(() => {
    if (!selection) return;
    const dismiss = (event: PointerEvent) => {
      if (selectionToolbar.current?.contains(event.target as Node)) return;
      setSelection(null);
    };
    const dismissOnScroll = () => setSelection(null);
    document.addEventListener("pointerdown", dismiss, true);
    readerCanvas.current?.addEventListener("scroll", dismissOnScroll, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      readerCanvas.current?.removeEventListener("scroll", dismissOnScroll);
    };
  }, [selection]);

  useEffect(() => {
    const document = documentQuery.data;
    if (!autoFormatMarkdown || !paper || !document || !formattingModel || !formattingProvider || !formattingCredentialReady) return;
    const key = `${paper.id}:${document.source_sha256}:${formattingModel.id}:${MARKDOWN_FORMAT_PROMPT_VERSION}`;
    if (document.formatting?.model_id === formattingModel.id && document.formatting.prompt_version === MARKDOWN_FORMAT_PROMPT_VERSION) return;
    if (autoFormattingKey.current === key) return;
    autoFormattingKey.current = key;
    void formatDocument();
  }, [autoFormatMarkdown, documentQuery.data, formattingCredentialReady, formattingModel?.id, formattingProvider?.id, paper?.id]);

  if (!paper) return <main className="reader-empty"><BookOpen size={34} /><h2>No paper selected</h2><p>Choose a paper in Library, then open it in Reader.</p><button className="primary-button compact" onClick={() => setView("library")}>Open Library</button></main>;

  const credentialReady = !nativeRuntime || Boolean(selectedProvider && providerCredentialQuery.data?.some(
    (summary) => summary.credentialId === selectedProvider.credentialId && summary.configured,
  ));

  const updateTranslation = (blockId: string, update: (current: TranslationState) => TranslationState) => {
    setTranslations((current) => ({
      ...current,
      [blockId]: update(current[blockId] ?? { status: "streaming", text: "" }),
    }));
  };

  const translate = async (block: ReaderBlock) => {
    if (!selectedModel || !selectedProvider || !credentialReady) {
      setTranslations((current) => ({ ...current, [block.id]: { status: "error", text: "", error: "Configure this model's API key in Settings before starting translation." } }));
      return;
    }
    const existing = streamHandles.current.get(block.id);
    if (existing) {
      await existing.cancel();
      existing.dispose();
      streamHandles.current.delete(block.id);
    }
    setActiveBlock(block.id);
    setActiveAnalysis(null);
    setTranslations((current) => ({ ...current, [block.id]: { status: "streaming", text: "" } }));
    const requestId = crypto.randomUUID();
    const onEvent = (event: ModelStreamEvent) => {
      if (event.kind === "delta" && event.text) {
        updateTranslation(block.id, (current) => ({ ...current, status: "streaming", text: current.text + event.text }));
      } else if (event.kind === "done") {
        updateTranslation(block.id, (current) => ({ ...current, status: "unsaved" }));
      } else if (event.kind === "cancelled") {
        updateTranslation(block.id, (current) => ({ ...current, status: "cancelled" }));
      } else if (event.kind === "error") {
        updateTranslation(block.id, (current) => ({ ...current, status: "error", error: event.error ?? "Model request failed." }));
      }
      if (["done", "cancelled", "error"].includes(event.kind)) {
        streamHandles.current.get(block.id)?.dispose();
        streamHandles.current.delete(block.id);
      }
    };
    try {
      const handle = await startModelStream({
        requestId,
        provider: selectedProvider,
        model: selectedModel,
        temperature: 0.1,
        messages: [
          { role: "system", content: "Translate scientific prose faithfully into Simplified Chinese. Preserve Markdown, LaTeX, terminology, citations, numbers, and uncertainty. Return only the translation." },
          { role: "user", content: block.text },
        ],
      }, onEvent);
      streamHandles.current.set(block.id, handle);
    } catch (error) {
      updateTranslation(block.id, (current) => ({ ...current, status: "error", error: error instanceof Error ? error.message : String(error) }));
    }
  };

  const cancelTranslation = async (blockId: string) => {
    await streamHandles.current.get(blockId)?.cancel();
  };

  const persistTranslation = async (block: ReaderBlock, state: TranslationState) => {
    if (!selectedModel || !state.text.trim()) return;
    try {
      const record = await saveTranslation(root, {
        paperId: paper.id,
        sectionId: block.sectionId,
        blockId: block.id,
        sourceText: block.text,
        translatedText: state.text,
        targetLanguage: "zh-CN",
        modelId: selectedModel.id,
        promptVersion: TRANSLATION_PROMPT_VERSION,
      });
      setTranslations((current) => ({ ...current, [block.id]: { status: "saved", text: record.translatedText, record } }));
      await translationQuery.refetch();
    } catch (error) {
      updateTranslation(block.id, (current) => ({ ...current, status: "error", error: error instanceof Error ? error.message : String(error) }));
    }
  };

  const updateAnalysis = (key: string, update: (current: AnalysisState) => AnalysisState) => {
    setAnalysisStates((current) => ({
      ...current,
      [key]: update(current[key] ?? {
        status: "streaming",
        text: "",
        adjacentContext: "",
        usage: { inputTokens: 0, outputTokens: 0, durationMs: 0 },
      }),
    }));
  };

  const adjacentContextFor = (block: ReaderBlock) => {
    const blocks = sections.flatMap((section) => section.blocks);
    const index = blocks.findIndex((candidate) => candidate.id === block.id);
    if (index < 0) return block.text;
    return blocks.slice(Math.max(0, index - 1), index + 2).map((candidate) => candidate.text).join("\n\n");
  };

  const explain = async (type: ReaderAnalysisType, block: ReaderBlock) => {
    const key = analysisKey(block.id, type);
    setActiveBlock(block.id);
    setActiveAnalysis({ blockId: block.id, type });
    if (!selectedModel || !selectedProvider || !credentialReady) {
      setAnalysisStates((current) => ({ ...current, [key]: {
        status: "error",
        text: "",
        adjacentContext: "",
        usage: { inputTokens: 0, outputTokens: 0, durationMs: 0 },
        error: "Configure this model's API key in Settings before requesting an explanation.",
      } }));
      return;
    }
    const handleKey = `analysis:${key}`;
    const existing = streamHandles.current.get(handleKey);
    if (existing) {
      await existing.cancel();
      existing.dispose();
      streamHandles.current.delete(handleKey);
    }
    const adjacentContext = adjacentContextFor(block);
    const started = performance.now();
    let text = "";
    let terminal = false;
    setAnalysisStates((current) => ({ ...current, [key]: {
      status: "streaming",
      text: "",
      adjacentContext,
      usage: { inputTokens: 0, outputTokens: 0, durationMs: 0 },
    } }));
    const onEvent = (event: ModelStreamEvent) => {
      if (event.kind === "delta" && event.text) {
        text += event.text;
        updateAnalysis(key, (current) => ({ ...current, status: "streaming", text }));
      } else if (event.kind === "done") {
        terminal = true;
        updateAnalysis(key, (current) => ({ ...current, status: "unsaved", text, usage: {
          inputTokens: event.usage?.inputTokens ?? 0,
          outputTokens: event.usage?.outputTokens ?? 0,
          durationMs: Math.round(performance.now() - started),
        } }));
      } else if (event.kind === "cancelled") {
        terminal = true;
        updateAnalysis(key, (current) => ({ ...current, status: "cancelled", text, usage: { ...current.usage, durationMs: Math.round(performance.now() - started) } }));
      } else if (event.kind === "error") {
        terminal = true;
        updateAnalysis(key, (current) => ({ ...current, status: "error", text, error: event.error ?? "Model request failed.", usage: { ...current.usage, durationMs: Math.round(performance.now() - started) } }));
      }
      if (["done", "cancelled", "error"].includes(event.kind)) {
        streamHandles.current.get(handleKey)?.dispose();
        streamHandles.current.delete(handleKey);
      }
    };
    try {
      const handle = await startModelStream({
        requestId: crypto.randomUUID(),
        provider: selectedProvider,
        model: selectedModel,
        temperature: 0.1,
        messages: [
          { role: "system", content: type === "formula"
            ? "Explain the supplied scientific formula rigorously. Identify the exact expression, define every symbol, explain dimensions and operations, connect it to adjacent method text, and state assumptions or ambiguities. Preserve LaTeX and cite the provided section/block/page anchor."
            : "Explain the supplied scientific claim or theorem rigorously. Separate statement, assumptions, reasoning or proof sketch, implications, limitations, and unresolved gaps. Do not invent a proof. Cite the provided section/block/page anchor." },
          { role: "user", content: `Source anchor: paper=${paper.id}, section=${block.sectionId}, block=${block.id}, page=${block.page ?? "unknown"}\n\nTarget source:\n${block.text}\n\nAdjacent structured context:\n${adjacentContext}` },
        ],
      }, onEvent);
      if (terminal) handle.dispose();
      else streamHandles.current.set(handleKey, handle);
    } catch (error) {
      updateAnalysis(key, (current) => ({ ...current, status: "error", error: error instanceof Error ? error.message : String(error) }));
    }
  };

  const persistAnalysis = async (block: ReaderBlock, type: ReaderAnalysisType, state: AnalysisState) => {
    if (!selectedModel || !state.text.trim()) return;
    const key = analysisKey(block.id, type);
    try {
      const record = await saveReaderAnalysis(root, {
        paperId: paper.id,
        sectionId: block.sectionId,
        blockId: block.id,
        analysisType: type,
        sourceText: block.text,
        adjacentContext: state.adjacentContext,
        resultText: state.text,
        modelId: selectedModel.id,
        promptVersion: ANALYSIS_PROMPT_VERSION,
        inputTokens: state.usage.inputTokens,
        outputTokens: state.usage.outputTokens,
        durationMs: state.usage.durationMs,
      });
      setAnalysisStates((current) => ({ ...current, [key]: { ...state, status: "saved", text: record.resultText, record } }));
      await analysisQuery.refetch();
    } catch (error) {
      updateAnalysis(key, (current) => ({ ...current, status: "error", error: error instanceof Error ? error.message : String(error) }));
    }
  };

  const assembleChatContext = async (): Promise<{ snapshot: ContextSnapshot; contextText: string }> => {
    const draft = await getContextDraft(root);
    const snapshotItems: ContextSnapshot["items"] = [];
    const content: string[] = [];
    for (const item of draft.items) {
      const source = await readContextItem(root, item.id);
      let sourceText = source.sourceText;
      if (item.mode === "compressed" && item.compression) {
        const compression = await getContextCompression(root, item.id, item.compression.modelId, item.compression.promptVersion);
        if (compression) sourceText = compression.compressedText;
      }
      content.push(`## ${item.paperTitle}${item.sectionId ? ` / ${item.sectionId}` : ""}\n${sourceText}`);
      snapshotItems.push({
        contextItemId: item.id,
        paperId: item.paperId,
        sourceHash: item.sourceHash,
        mode: item.mode,
        sectionIds: item.sectionId ? [item.sectionId] : [],
        figureIds: [],
        estimatedTokens: item.estimatedTokens,
      });
    }
    if (!snapshotItems.some((item) => item.paperId === paper.id)) {
      const sourceText = markdownQuery.data ?? "";
      content.unshift(`## ${paper.title}\n${sourceText}`);
      snapshotItems.unshift({
        paperId: paper.id,
        sourceHash: documentQuery.data?.source_sha256,
        mode: "structured",
        sectionIds: [],
        figureIds: [],
        estimatedTokens: Math.ceil(new TextEncoder().encode(sourceText).length / 4),
      });
    }
    const maxCharacters = Math.max(16000, Math.floor((selectedModel?.maxContextTokens ?? 128000) * 2.8));
    return {
      contextText: content.join("\n\n").slice(0, maxCharacters),
      snapshot: {
        id: crypto.randomUUID(),
        agentProfileId: "reader-paper-analyst",
        modelId: selectedModel?.id ?? "",
        items: snapshotItems,
        tokenBreakdown: draft.tokenBreakdown,
        promptVersion: CHAT_PROMPT_VERSION,
        toolVersions: { read_paper: "1", read_section: "1", find_evidence: "1" },
        retrievalQueries: [],
        externalResults: [],
        createdAt: new Date().toISOString(),
      },
    };
  };

  const sendChat = async (retryTurn?: ReaderChatTurn) => {
    if (chatStatus === "streaming") return;
    const userMessage = retryTurn?.userMessage ?? chatInput.trim();
    if (!userMessage) return;
    if (!selectedModel || !selectedProvider || !credentialReady) {
      setChatStatus("error");
      setChatError("Configure this model's API key in Settings before asking the paper agent.");
      return;
    }
    setChatInput("");
    setChatLive("");
    setChatPendingQuestion(userMessage);
    setChatError("");
    setChatStatus("streaming");
    let assembled: Awaited<ReturnType<typeof assembleChatContext>>;
    try {
      assembled = await assembleChatContext();
    } catch (error) {
      setChatInput(userMessage);
      setChatPendingQuestion("");
      setChatStatus("error");
      setChatError(error instanceof Error ? error.message : String(error));
      return;
    }
    const started = performance.now();
    let responseText = "";
    let terminal = false;
    const priorMessages = (chatQuery.data?.turns ?? []).slice(-6).flatMap((turn) => [
      { role: "user" as const, content: turn.userMessage },
      ...(turn.response?.assistantText ? [{ role: "assistant" as const, content: turn.response.assistantText }] : []),
    ]);
    const persistTerminal = async (status: "completed" | "cancelled" | "failed", event: ModelStreamEvent) => {
      if (terminal) return;
      terminal = true;
      const finalStatus = status === "completed" && !responseText.trim() ? "failed" : status;
      const finalError = finalStatus === "failed" ? event.error ?? "The model returned an empty response." : undefined;
      try {
        await saveReaderChatTurn(root, {
          paperId: paper.id,
          turnId: retryTurn?.id,
          userMessage,
          assistantText: responseText,
          contextSnapshot: retryTurn?.contextSnapshot ?? assembled.snapshot,
          modelId: selectedModel.id,
          promptVersion: CHAT_PROMPT_VERSION,
          status: finalStatus,
          inputTokens: event.usage?.inputTokens,
          outputTokens: event.usage?.outputTokens,
          durationMs: Math.round(performance.now() - started),
          error: finalError,
        });
        await chatQuery.refetch();
        setChatStatus(finalStatus === "failed" ? "error" : "idle");
        setChatError(finalError ?? "");
      } catch (error) {
        setChatStatus("error");
        setChatError(error instanceof Error ? error.message : String(error));
      } finally {
        chatHandle.current?.dispose();
        chatHandle.current = null;
        setChatLive("");
        setChatPendingQuestion("");
      }
    };
    const onEvent = (event: ModelStreamEvent) => {
      if (event.kind === "delta" && event.text) {
        responseText += event.text;
        setChatLive(responseText);
      } else if (event.kind === "done") void persistTerminal("completed", event);
      else if (event.kind === "cancelled") void persistTerminal("cancelled", event);
      else if (event.kind === "error") void persistTerminal("failed", event);
    };
    try {
      const handle = await startModelStream({
        requestId: crypto.randomUUID(),
        provider: selectedProvider,
        model: selectedModel,
        temperature: 0.2,
        messages: [
          { role: "system", content: "You are the Reader paper analyst. Answer from the supplied local paper context. Every factual claim must cite paper, section, block, or page when available. Distinguish direct evidence from inference and say when the context is insufficient." },
          ...priorMessages,
          { role: "user", content: `Question: ${userMessage}\n\nCurrent local research context:\n${assembled.contextText}` },
        ],
      }, onEvent);
      if (terminal) handle.dispose();
      else chatHandle.current = handle;
    } catch (error) {
      await persistTerminal("failed", { requestId: crypto.randomUUID(), kind: "error", error: error instanceof Error ? error.message : String(error) });
    }
  };

  const cancelChat = async () => {
    await chatHandle.current?.cancel();
  };

  const clearChat = async () => {
    if (!window.confirm("Clear this paper's persisted Reader conversation?")) return;
    await clearReaderConversation(root, paper.id);
    setChatLive("");
    setChatPendingQuestion("");
    setChatError("");
    await chatQuery.refetch();
  };
  const addContext = async (sectionId: string, blockId: string | undefined, sourceText: string) => {
    if (!paper) return;
    const key = blockId ?? sectionId;
    setContextBusy(key);
    try {
      const draft = await addSelectionToContext(root, { paperId: paper.id, sectionId, blockId, sourceText });
      queryClient.setQueryData(["context-draft", root], draft);
    } finally {
      setContextBusy("");
    }
  };
  const togglePaperContext = async () => {
    if (!paper) return;
    setContextBusy("paper");
    try {
      const draft = fullText
        ? await removePaperFromContext(root, paper.id)
        : await addPaperToContext(root, paper.id, "full");
      queryClient.setQueryData(["context-draft", root], draft);
    } finally {
      setContextBusy("");
    }
  };
  const streamFormattedChunk = (chunk: string): Promise<string> => new Promise((resolve, reject) => {
    if (!formattingModel || !formattingProvider) {
      reject(new Error("Choose a Markdown formatting model in Settings."));
      return;
    }
    let output = "";
    let terminal = false;
    const onEvent = (event: ModelStreamEvent) => {
      if (event.kind === "delta" && event.text) output += event.text;
      if (event.kind === "done") {
        terminal = true;
        if (output.trim()) resolve(output);
        else reject(new Error("Formatting model returned empty Markdown."));
      } else if (event.kind === "cancelled") {
        terminal = true;
        reject(new Error("Markdown formatting was cancelled."));
      } else if (event.kind === "error") {
        terminal = true;
        reject(new Error(event.error ?? "Markdown formatting failed."));
      }
      if (terminal) {
        formattingHandle.current?.dispose();
        formattingHandle.current = null;
      }
    };
    void startModelStream({
      requestId: crypto.randomUUID(),
      provider: formattingProvider,
      model: formattingModel,
      temperature: 0,
      messages: [
        { role: "system", content: "You are a lossless scientific Markdown editor. Improve only structure and readability: reconstruct sensible paragraphs and line breaks, normalize headings and lists, put bibliography entries on separate lines, and repair obvious OCR word-wrap hyphenation. Never summarize, translate, correct claims, change wording, alter citations, numbers, names, formulas, tables, image paths, or add content. Preserve every [[P2I_EVIDENCE_ANCHOR_N]] placeholder exactly. Return Markdown only, without a code fence." },
        { role: "user", content: chunk },
      ],
    }, onEvent).then((handle) => {
      if (terminal) handle.dispose();
      else formattingHandle.current = handle;
    }).catch(reject);
  });

  async function formatDocument() {
    const document = documentQuery.data;
    if (!paper || !document || !formattingModel || !formattingProvider) return;
    if (!formattingCredentialReady) {
      setFormattingStatus("error");
      setFormattingError("Store this formatting model's API key in Settings first.");
      return;
    }
    setFormattingStatus("formatting");
    setFormattingProgress(0);
    setFormattingError("");
    try {
      const formattedSections: Array<{ id: string; markdown: string }> = [];
      const totalSections = Math.max(1, document.sections.length);
      for (let sectionIndex = 0; sectionIndex < document.sections.length; sectionIndex += 1) {
        const section = document.sections[sectionIndex];
        const prepared = prepareMarkdownForFormatting(section.markdown);
        const outputLimit = Math.max(2000, (formattingModel.maxOutputTokens - 512) * 3);
        const contextLimit = Math.max(2000, (formattingModel.maxContextTokens - formattingModel.maxOutputTokens - 2000) * 3);
        const chunks = splitMarkdownForFormatting(prepared.promptText, Math.min(outputLimit, contextLimit, 12000));
        const outputs: string[] = [];
        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
          outputs.push(await streamFormattedChunk(chunks[chunkIndex]));
          setFormattingProgress(Math.round(((sectionIndex + (chunkIndex + 1) / chunks.length) / totalSections) * 100));
        }
        formattedSections.push({ id: section.id, markdown: restoreFormattedMarkdown(outputs.join("\n\n"), prepared.anchors) });
      }
      const saved = await saveFormattedDocument(root, {
        paperId: paper.id,
        sections: formattedSections,
        modelId: formattingModel.id,
        promptVersion: MARKDOWN_FORMAT_PROMPT_VERSION,
        sourceSha256: document.source_sha256,
      });
      queryClient.setQueryData(["paper-document", root, paper.id], saved);
      await markdownQuery.refetch();
      setFormattingProgress(100);
      setFormattingStatus("saved");
    } catch (error) {
      setFormattingStatus("error");
      setFormattingError(error instanceof Error ? error.message : String(error));
    } finally {
      formattingHandle.current?.dispose();
      formattingHandle.current = null;
    }
  }

  const captureSelection = (block: ReaderBlock, event: ReactMouseEvent<HTMLElement>) => {
    const selected = window.getSelection();
    const text = selected?.toString().trim();
    if (!text) return;
    const range = selected?.rangeCount ? selected.getRangeAt(0) : undefined;
    const rect = range?.getBoundingClientRect();
    const start = Math.min(selected?.anchorOffset ?? 0, selected?.focusOffset ?? 0);
    const end = Math.max(selected?.anchorOffset ?? text.length, selected?.focusOffset ?? text.length);
    const center = rect && rect.width > 0 ? rect.left + rect.width / 2 : event.clientX;
    const placeAbove = (rect?.top ?? event.clientY) > 64;
    setSelection({
      ...block,
      text: text.slice(0, 2000),
      start,
      end,
      left: Math.max(120, Math.min(window.innerWidth - 120, center)),
      top: placeAbove ? (rect?.top ?? event.clientY) - 8 : (rect?.bottom ?? event.clientY) + 8,
      placement: placeAbove ? "above" : "below",
    });
  };

  return <div className="reader-workspace">
    {selection && <div ref={selectionToolbar} className={`selection-popover ${selection.placement}`} style={{ left: selection.left, top: selection.top }} role="toolbar" aria-label="Selected text actions"><button title="Translate selected text" onClick={() => void translate(selection)}><Languages size={14} /> Translate</button><button title="Explain selected text" onClick={() => void explain("theorem", selection)}><Sparkles size={14} /> Explain</button><button className="icon-button" title="Close" onClick={() => setSelection(null)}><X size={14} /></button></div>}
    <div className="reader-toolbar">
      <button onClick={() => setView("library")}><ChevronLeft size={13} /> Library</button>
      <strong title={paper.title}>{paper.title}</strong>
      <div className="reader-mode-switch"><button className={mode === "integrated" ? "active" : ""} onClick={() => setMode("integrated")}>Integrated Reading</button><button className={mode === "pdf" ? "active" : ""} onClick={() => setMode("pdf")}>PDF Only</button><button className={mode === "figures" ? "active" : ""} onClick={() => setMode("figures")}>Figures</button></div>
      <button><Search size={13} /> Find</button><button className={formattingStatus === "saved" ? "active" : ""} disabled={formattingStatus === "formatting"} title={formattingError || `Format Markdown with ${formattingModel?.displayName ?? "the selected model"}`} onClick={() => void formatDocument()}>{formattingStatus === "formatting" ? <LoaderCircle className="spin" size={13} /> : <WandSparkles size={13} />} {formattingStatus === "formatting" ? `${formattingProgress}%` : "Format"}</button><button className={fullText ? "active" : ""} disabled={contextBusy === "paper"} onClick={() => void togglePaperContext()}><Layers3 size={13} /> {fullText ? `Paper Context · ${contextPercent}%` : "Load Full Text"}</button><button className="reader-agent-toggle" onClick={() => setAgentOpen(true)}><Bot size={13} /> Ask AI</button>
    </div>
    <div className="reader-main">
      <aside className="reader-outline"><span>Sections</span>{sections.map((section, index) => <button key={section.id} className={activeSection === section.id ? "active" : ""} style={{ paddingLeft: `${10 + Math.max(0, section.level - 1) * 12}px` }} onClick={() => { setActiveSection(section.id); document.getElementById(`reader-section-${section.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}><b>{String(index + 1).padStart(2, "0")}</b><span>{section.title}</span><small>{section.pageStart ? section.pageStart === section.pageEnd ? `p. ${section.pageStart}` : `pp. ${section.pageStart}-${section.pageEnd}` : `${section.blocks.length}`}</small></button>)}</aside>
      <main className="reader-canvas" ref={readerCanvas}>
        {mode === "integrated" && <article className="integrated-paper">
          <header className="paper-reading-header"><span className="tag tag-primary">STRUCTURED DOCUMENT</span><h1>{paper.title}</h1><p>Local document · {paper.pageCount || "—"} pages · Updated {new Date(paper.updatedAt).toLocaleDateString()}</p></header>
          {formattingStatus === "error" && <div className="formatting-notice error"><TriangleAlert size={13} /> {formattingError}</div>}
          {markdownQuery.isLoading || documentQuery.isLoading ? <div className="document-loading">Loading structured document…</div> : sections.map((section, sectionIndex) => <section id={`reader-section-${section.id}`} data-section-id={section.id} className={`reading-section ${activeSection === section.id ? "active" : ""}`} key={section.id}>
            <header><div className="section-heading"><span className="section-kicker">Section {String(sectionIndex + 1).padStart(2, "0")}</span><h2>{section.title}</h2><span>{section.blocks.length} paragraphs{section.pageStart ? ` · ${section.pageStart === section.pageEnd ? `page ${section.pageStart}` : `pages ${section.pageStart}-${section.pageEnd}`}` : ""}</span></div><button disabled={contextBusy === section.id} onClick={() => void addContext(section.id, undefined, section.blocks.map((block) => block.text).join("\n\n"))}><Layers3 size={12} /> {contextDraftQuery.data?.items.some((item) => item.paperId === paper.id && item.sectionId === section.id && !item.blockId) ? "Added" : "Add Section"}</button></header>
            <div className="paragraph-stack">{section.blocks.map((block, blockIndex) => {
              const state = translations[block.id] ?? persistedTranslations[block.id];
              const hasFormula = /\$|\\\[|\\begin\{equation/.test(block.text);
              const explanationType = activeAnalysis?.blockId === block.id ? activeAnalysis.type : hasFormula ? "formula" : "theorem";
              const explanation = analysisStates[analysisKey(block.id, explanationType)] ?? persistedAnalyses[analysisKey(block.id, explanationType)];
              return <div className={`paragraph-card ${activeBlock === block.id ? "active" : ""}`} key={block.id} onMouseUp={(event) => captureSelection(block, event)}>
                <div className="paragraph-main"><span className="paragraph-number">{sectionIndex ? `${sectionIndex}.${blockIndex + 1}` : `A${blockIndex + 1}`}</span><div className="paragraph-markdown"><MarkdownBlock value={block.text} /></div></div>
                <div className="paragraph-actions"><button title="Translate paragraph" aria-label="Translate paragraph" onClick={() => void translate(block)}><Languages size={14} /></button><button title={hasFormula ? "Explain formula" : "Explain paragraph"} aria-label={hasFormula ? "Explain formula" : "Explain paragraph"} onClick={() => void explain(hasFormula ? "formula" : "theorem", block)}><Sparkles size={14} /></button><button className={contextDraftQuery.data?.items.some((item) => item.paperId === paper.id && item.blockId === block.id) ? "active" : ""} title="Add paragraph to context" aria-label="Add paragraph to context" disabled={contextBusy === block.id} onClick={() => void addContext(block.sectionId, block.id, block.text)}><Layers3 size={14} /></button></div>
                {state && <TranslationPanel block={block} state={state} onSave={() => void persistTranslation(block, state)} onRetry={() => void translate(block)} onCancel={() => void cancelTranslation(block.id)} />}
                {explanation && <AnalysisCard block={block} type={explanationType} state={explanation} onSave={() => void persistAnalysis(block, explanationType, explanation)} onRetry={() => void explain(explanationType, block)} onCancel={() => void streamHandles.current.get(`analysis:${analysisKey(block.id, explanationType)}`)?.cancel()} onFollowUp={() => { setChatInput(`Follow up on the ${explanationType} explanation for ${block.sectionId}/${block.id}: `); setAgentOpen(true); }} />}
              </div>;
            })}</div>
          </section>)}
        </article>}
        {mode === "pdf" && <div className="integrated-pdf">{assetUrl(paper.sourcePath) ? <iframe title="Source PDF" src={assetUrl(paper.sourcePath)} /> : <div className="pdf-placeholder"><FileText size={38} /><h2>Native PDF preview</h2><p>The source PDF is displayed here in the Windows desktop build.</p></div>}</div>}
        {mode === "figures" && <div className="reader-figures">{paper.figures.length ? paper.figures.map((figure) => <figure key={figure.id}>{assetUrl(`${paper.markdownPath?.replace(/[\\/][^\\/]+$/, "")}/${figure.relativePath}`) ? <img src={assetUrl(`${paper.markdownPath?.replace(/[\\/][^\\/]+$/, "")}/${figure.relativePath}`)} alt={figure.caption ?? "Extracted figure"} /> : <div><FileImage size={32} /></div>}<figcaption>{figure.caption ?? "Extracted figure"}</figcaption></figure>) : <div className="pdf-placeholder"><FileImage size={36} /><h2>No extracted figures</h2><p>Figures will appear after the parser finishes extraction.</p></div>}</div>}
      </main>
      <aside className={`reader-agent-panel ${agentOpen ? "open" : ""}`}>
        <header><Bot size={15} /><strong>Paper Analyst Agent</strong><span className={`tag ${credentialReady ? "tag-success" : "tag-warning"}`}>{credentialReady ? "Gateway ready" : selectedProvider ? "Needs key" : "Needs model"}</span><button className="reader-agent-close" title="Close agent" onClick={() => setAgentOpen(false)}><ChevronLeft size={13} /></button></header>
        <div className="agent-panel-scroll">
          <div className="agent-chat-summary"><div><strong>Conversation Context</strong><b>{contextPercent}%</b></div><div className="context-track"><i style={{ width: `${contextPercent}%` }} /></div><span>{(contextUsed / 1000).toFixed(1)}K / {(maxContextTokens / 1000).toFixed(0)}K · {contextDraftQuery.data?.items.length ?? 0} items</span><button title="Open Context Workspace" onClick={() => setView("context")}><Layers3 size={11} /></button>{Boolean(chatQuery.data?.turns.length) && <button title="Clear conversation" onClick={() => void clearChat()}><Trash2 size={11} /></button>}</div>
          <label className="agent-model-field"><span>Paper analyst model</span><select value={agentModel} onChange={(event) => setAgentModel(event.target.value)}>{customModels.map((model) => <option key={model.id} value={model.id}>{model.displayName} · {providers.find((provider) => provider.id === model.providerId)?.format ?? "unavailable"}</option>)}</select></label>
          <div className="agent-chat-thread">
            {!chatQuery.data?.turns.length && chatStatus !== "streaming" && <div className="agent-chat-empty"><MessageSquareText size={18} /><strong>Ask this paper</strong><span>Answers use the persisted research context and retain revision history.</span></div>}
            {(chatQuery.data?.turns ?? []).map((turn) => <div className="agent-chat-turn" key={turn.id}>
              <div className="chat-message user"><span>You</span><p>{turn.userMessage}</p></div>
              <div className={`chat-message assistant ${turn.response?.status ?? "pending"}`}><span>Paper Analyst{turn.response ? ` · Revision ${turn.response.revision}` : ""}</span>{turn.response?.assistantText ? <div className="chat-markdown"><MarkdownBlock value={turn.response.assistantText} /></div> : <p>{turn.response?.error ?? "No response was produced."}</p>}<footer><small>{turn.response?.status ?? "pending"}{turn.response?.usage ? ` · ${turn.response.usage.outputTokens} tokens · ${(turn.response.usage.durationMs / 1000).toFixed(1)}s` : ""}</small>{turn.response && turn.response.status !== "completed" && <button onClick={() => void sendChat(turn)}><RefreshCw size={10} /> Retry</button>}</footer></div>
            </div>)}
            {chatStatus === "streaming" && <div className="agent-chat-turn live"><div className="chat-message user"><span>You</span><p>{chatPendingQuestion}</p></div><div className="chat-message assistant streaming"><span><LoaderCircle className="spin" size={11} /> Paper Analyst</span>{chatLive ? <div className="chat-markdown"><MarkdownBlock value={chatLive} /></div> : <p>Waiting for the first model token…</p>}<footer><button onClick={() => void cancelChat()}><Square size={9} /> Cancel</button></footer></div></div>}
            {chatError && <p className="agent-chat-error"><TriangleAlert size={12} /> {chatError}</p>}
          </div>
        </div>
        <form className="agent-chat-input" onSubmit={(event) => { event.preventDefault(); void sendChat(); }}><MessageSquareText size={13} /><input aria-label="Ask about this paper" value={chatInput} onChange={(event) => setChatInput(event.target.value)} disabled={chatStatus === "streaming"} placeholder="Ask about this paper…" /><button title="Send" type="submit" disabled={!chatInput.trim() || chatStatus === "streaming"}><Send size={13} /></button></form>
      </aside>
    </div>
    <footer className="reader-context-bar"><Layers3 size={14} /><strong>Conversation Context</strong><span className="tag tag-primary">{contextDraftQuery.data?.items.length ?? 0} persisted items</span><div className="context-track"><i style={{ width: `${contextPercent}%` }} /></div><code>{(contextUsed / 1000).toFixed(1)}K / {(maxContextTokens / 1000).toFixed(0)}K · {contextPercent}%</code><span>Shared by Reader, Context, Agents and Innovate.</span><button onClick={() => setView("context")}>Open Context</button></footer>
  </div>;
}

function TranslationPanel({ block, state, onSave, onRetry, onCancel }: { block: ReaderBlock; state: TranslationState; onSave: () => void; onRetry: () => void; onCancel: () => void }) {
  return <div className={`translation-result ${state.status}`} data-block-id={block.id}>
    <div><span className="tag tag-ai">Chinese Translation{state.record ? ` · Revision ${state.record.revision}` : ""}</span>{state.status === "saved" && <span className="tag tag-success"><Check size={10} /> Saved</span>}</div>
    {state.status === "streaming" && !state.text && <p><LoaderCircle className="spin" size={13} /> Waiting for the first model token…</p>}
    {state.text && <div className="translation-markdown"><MarkdownBlock value={state.text} /></div>}
    {state.error && <p className="translation-error"><TriangleAlert size={13} /> {state.error}</p>}
    <footer>
      {state.status === "streaming" ? <button onClick={onCancel}><Square size={10} /> Cancel</button> : <button onClick={onRetry}><RefreshCw size={11} /> {state.status === "error" ? "Retry" : "Retranslate"}</button>}
      {state.status === "unsaved" && <button onClick={onSave}>Save Translation</button>}
      {state.status === "saved" && <button className="active" disabled>Persisted</button>}
    </footer>
  </div>;
}

function AnalysisCard({ block, type, state, onSave, onRetry, onCancel, onFollowUp }: { block: ReaderBlock; type: ReaderAnalysisType; state: AnalysisState; onSave: () => void; onRetry: () => void; onCancel: () => void; onFollowUp: () => void }) {
  const title = type === "formula" ? "Formula Explanation" : "Theorem Explanation";
  return <div className={`reader-analysis ${type} ${state.status}`} data-block-id={block.id}>
    <div className="reader-analysis-head"><span className="tag tag-ai">AI {title}{state.record ? ` · Revision ${state.record.revision}` : ""}</span>{state.status === "saved" && <span className="tag tag-success"><Check size={10} /> Saved</span>}</div>
    {state.status === "streaming" && !state.text && <p className="analysis-wait"><LoaderCircle className="spin" size={13} /> Waiting for the first model token…</p>}
    {state.text && <div className="analysis-markdown"><MarkdownBlock value={state.text} /></div>}
    {state.error && <p className="translation-error"><TriangleAlert size={13} /> {state.error}</p>}
    <div className="analysis-provenance"><code>{block.sectionId}/{block.id}{block.page ? ` · page ${block.page}` : ""}</code><span>{state.usage.outputTokens} output tokens · {(state.usage.durationMs / 1000).toFixed(1)}s</span></div>
    <footer>{state.status === "streaming" ? <button onClick={onCancel}><Square size={10} /> Cancel</button> : <button onClick={onRetry}><RefreshCw size={11} /> {state.status === "error" ? "Retry" : "Regenerate"}</button>}{state.status === "unsaved" && <button onClick={onSave}>Save Explanation</button>}{state.status === "saved" && <button className="active" disabled>Persisted</button>}<button onClick={onFollowUp}><MessageSquareText size={11} /> Ask Follow-up</button></footer>
  </div>;
}
