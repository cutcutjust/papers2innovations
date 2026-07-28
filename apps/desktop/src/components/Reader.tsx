import type { ContextDraftItem, ContextSnapshot, FigureAnalysis, LibraryPaper, ModelStreamEvent, PromptTemplateCategory, ReaderAnalysisRecord, ReaderAnalysisType, ReaderChatTurn, TranslationRecord, TranslationSegment, TranslationTerm } from "@p2i/contracts";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, BookOpenText, Bot, Check, ChevronLeft, FileImage, FileText, Languages, Layers3, LoaderCircle, Maximize2, MessageSquareText, Minimize2, Minus, Palette, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Plus, RefreshCw, RotateCcw, Search, Send, Sparkles, Square, Trash2, TriangleAlert, Volume2, WandSparkles, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { activateContextCompression, addPaperToContext, addSelectionToContext, assetUrl, clearReaderConversation, deleteScopedContextItem, getContextCompression, getContextDraft, getReaderConversation, listFigureAnalyses, listPromptTemplates, listReaderAnalyses, listReaderAnnotations, listTranslations, nativeRuntime, readContextItem, readDocument, readMarkdown, removePaperFromContext, resetContextScope, retryFigureAnalysis, saveContextCompression, saveFormattedDocument, saveReaderAnalysis, saveReaderAnnotation, saveReaderChatTurn, saveTranslation, startModelStream, upsertScopedContextItem, type ModelStreamHandle } from "../lib/bridge";
import { hydrateProviderCredentials } from "../lib/credentials";
import { buildReaderSections, compactReaderBlocks, resolveMarkdownAssetPath, type ReaderDisplaySection, type ReaderDocumentBlock } from "../lib/documentBlocks";
import { MARKDOWN_FORMAT_PROMPT_VERSION, prepareMarkdownForFormatting, restoreFormattedMarkdown, splitMarkdownForFormatting } from "../lib/markdownFormatting";
import { normalizeMarkdownMath } from "../lib/markdownMath";
import { CONTEXT_COMPRESSION_PROMPT_VERSION, contextCompressionBudgetError, contextCompressionMessages } from "../lib/contextCompression";
import { contrastRatio, parseStructuredTranslation, structuredTranslationPrompt } from "../lib/readerTranslation";
import { resolvePromptTemplate, selectedPromptId, selectPromptTemplate } from "../lib/promptTemplates";
import { buildWordLookupMessages, isSingleEnglishWord } from "../lib/wordLookup";
import { useWorkspace } from "../store";

type ReaderMode = "integrated" | "pdf" | "figures";
type ReaderBlock = ReaderDocumentBlock;
type ReaderSection = ReaderDisplaySection;
type SelectionSource = ReaderBlock & { start: number; end: number; left: number; top: number; placement: "above" | "below"; kind: "word" | "passage" };
type TranslationState = {
  status: "streaming" | "unsaved" | "saved" | "cancelled" | "error";
  text: string;
  raw?: string;
  segments?: TranslationSegment[];
  terms?: TranslationTerm[];
  kind?: "word" | "passage";
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

const TRANSLATION_PROMPT_VERSION = "reader-translate-v2";
const WORD_LOOKUP_PROMPT_VERSION = "reader-word-v1";
const ANALYSIS_PROMPT_VERSION = "reader-analysis-v1";
const CHAT_PROMPT_VERSION = "reader-chat-v1";
const READER_OUTLINE_WIDTH_KEY = "p2i.reader-outline-width";
const DEFAULT_OUTLINE_WIDTH = 224;
const MIN_OUTLINE_WIDTH = 176;
const MAX_OUTLINE_WIDTH = 360;
const COLLAPSED_OUTLINE_WIDTH = 44;
const READER_OUTLINE_COLLAPSED_KEY = "p2i.reader-outline-collapsed";
const READER_AGENT_WIDTH_KEY = "p2i.reader-agent-width";
const READER_AGENT_COLLAPSED_KEY = "p2i.reader-agent-collapsed";
const DEFAULT_AGENT_WIDTH = 340;
const MIN_AGENT_WIDTH = 280;
const MAX_AGENT_WIDTH = 520;
const COLLAPSED_AGENT_WIDTH = 44;
const READER_THEME_COLORS = {
  white: { background: "#ffffff", text: "#20242c" },
  warm: { background: "#fbf7ed", text: "#292820" },
  green: { background: "#edf5ee", text: "#203027" },
  dark: { background: "#20242a", text: "#e8ebef" },
} as const;
const analysisKey = (blockId: string, type: ReaderAnalysisType) => `${blockId}:${type}`;

const clampOutlineWidth = (width: number) => Math.min(MAX_OUTLINE_WIDTH, Math.max(MIN_OUTLINE_WIDTH, Math.round(width)));
const clampAgentWidth = (width: number) => Math.min(MAX_AGENT_WIDTH, Math.max(MIN_AGENT_WIDTH, Math.round(width)));

function MarkdownBlock({ value, markdownPath, figureAnalysisFor, onToggleFigure }: { value: string; markdownPath?: string; figureAnalysisFor?: (source?: string) => FigureAnalysis | undefined; onToggleFigure?: (source?: string) => void }) {
  return <ReactMarkdown
    remarkPlugins={[remarkGfm, remarkMath]}
    rehypePlugins={[rehypeKatex]}
    components={{
      img: ({ src, alt }) => {
        const resolved = resolveMarkdownAssetPath(markdownPath, src);
        const rendered = resolved && /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(resolved) ? assetUrl(resolved) : resolved;
        const analysis = figureAnalysisFor?.(src);
        return <span className="markdown-figure-inline"><img className="markdown-paper-figure" src={rendered} alt={alt ?? "Extracted paper figure"} loading="lazy" />{onToggleFigure && <button className={`figure-ai-button ${analysis?.status ?? "pending"}`} onClick={() => onToggleFigure(src)}><Sparkles size={13} /> {analysis?.status === "completed" ? "AI 图解" : analysis?.status === "failed" ? "重试图解" : "图解待处理"}</button>}{analysis?.description && analysis.id.endsWith(":expanded") && <div className="figure-ai-description"><MarkdownBlock value={analysis.description} /></div>}</span>;
      },
    }}
  >{normalizeMarkdownMath(value)}</ReactMarkdown>;
}

function InlineMarkdown({ value }: { value: string }) {
  return <ReactMarkdown
    remarkPlugins={[remarkGfm, remarkMath]}
    rehypePlugins={[rehypeKatex]}
    components={{ p: ({ children }) => <>{children}</> }}
  >{normalizeMarkdownMath(value)}</ReactMarkdown>;
}

function BilingualBlock({ block, state, view, markdownPath, chatAnnotated, figureAnalysisFor, onToggleFigure }: { block: ReaderBlock; state?: TranslationState; view: "original" | "translated"; markdownPath?: string; chatAnnotated: boolean; figureAnalysisFor?: (source?: string) => FigureAnalysis | undefined; onToggleFigure?: (source?: string) => void }) {
  const translated = state?.status === "saved" || state?.status === "unsaved";
  if (!translated || !state?.text) {
    return <div className={chatAnnotated ? "reader-source chat-annotated" : "reader-source"}><MarkdownBlock value={block.text} markdownPath={markdownPath} figureAnalysisFor={figureAnalysisFor} onToggleFigure={onToggleFigure} /></div>;
  }
  if (view === "original") {
    return <div className={`reader-source translated-annotated ${chatAnnotated ? "chat-annotated" : ""}`}><MarkdownBlock value={block.text} markdownPath={markdownPath} figureAnalysisFor={figureAnalysisFor} onToggleFigure={onToggleFigure} /></div>;
  }
  const structural = /(?:^|\n)(?:#{1,6}\s|[-*+>]\s|```|\|)|!\[[^\]]*\]\(/m.test(block.text);
  if (structural || !state.segments?.length) {
    return <div className={`reader-translated-overlay ${chatAnnotated ? "chat-annotated" : ""}`}><MarkdownBlock value={state.text} markdownPath={markdownPath} /></div>;
  }
  return <div className={`reader-translated-overlay sentence-aligned ${chatAnnotated ? "chat-annotated" : ""}`}>
    {state.segments.map((segment) => {
      const terms = state.terms?.filter((term) => !term.segmentId || term.segmentId === segment.id) ?? [];
      return <span className="translated-sentence" key={segment.id} tabIndex={terms.length ? 0 : undefined}>
        <InlineMarkdown value={segment.translatedText} />
        {terms.length > 0 && <span className="translation-term-popover" role="tooltip">
          <strong>固定搭配与专业术语</strong>
          {terms.map((term, index) => <span key={`${term.text}:${index}`}><b>{term.text}</b><i>{term.translation}</i><small>{term.explanation}</small></span>)}
        </span>}
      </span>;
    })}
  </div>;
}

export function Reader({ paper, root }: { paper?: LibraryPaper; root: string }) {
  const { setView, customModels, providers, contextCompressionModelId, markdownFormattingModelId, autoFormatMarkdown, readerFocusMode, setReaderFocusMode, readerZoom, setReaderZoom, readerTheme, setReaderTheme, readerBackgroundColor, readerTextColor, setReaderColors, readerTranslationView, setReaderTranslationView } = useWorkspace();
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
  const [promptPickerOpen, setPromptPickerOpen] = useState(false);
  const [readerPromptId, setReaderPromptId] = useState(() => selectedPromptId("reader"));
  const [translationPromptId, setTranslationPromptId] = useState(() => selectedPromptId("translation"));
  const [explanationPromptId, setExplanationPromptId] = useState(() => selectedPromptId("explanation"));
  const [markdownPromptId, setMarkdownPromptId] = useState(() => selectedPromptId("markdown"));
  const [outlineWidth, setOutlineWidth] = useState(() => {
    if (typeof window === "undefined") return DEFAULT_OUTLINE_WIDTH;
    const persisted = Number(window.localStorage.getItem(READER_OUTLINE_WIDTH_KEY));
    return Number.isFinite(persisted) && persisted > 0 ? clampOutlineWidth(persisted) : DEFAULT_OUTLINE_WIDTH;
  });
  const [outlineCollapsed, setOutlineCollapsed] = useState(() => window.localStorage.getItem(READER_OUTLINE_COLLAPSED_KEY) === "true");
  const [agentWidth, setAgentWidth] = useState(() => {
    const persisted = Number(window.localStorage.getItem(READER_AGENT_WIDTH_KEY));
    return Number.isFinite(persisted) && persisted > 0 ? clampAgentWidth(persisted) : DEFAULT_AGENT_WIDTH;
  });
  const [agentCollapsed, setAgentCollapsed] = useState(() => window.localStorage.getItem(READER_AGENT_COLLAPSED_KEY) === "true");
  const [contextNotice, setContextNotice] = useState("");
  const [contextManagerOpen, setContextManagerOpen] = useState(false);
  const [contextEditor, setContextEditor] = useState<{ itemId?: string; title: string; text: string } | null>(null);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [expandedFigures, setExpandedFigures] = useState<Set<string>>(() => new Set());
  const [pdfPage, setPdfPage] = useState(1);
  const [pdfNavigationKey, setPdfNavigationKey] = useState(0);
  const streamHandles = useRef(new Map<string, ModelStreamHandle>());
  const chatHandle = useRef<ModelStreamHandle | null>(null);
  const formattingHandle = useRef<ModelStreamHandle | null>(null);
  const autoFormattingKey = useRef("");
  const selectionToolbar = useRef<HTMLDivElement | null>(null);
  const readerCanvas = useRef<HTMLElement | null>(null);
  const outlineDrag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const agentDrag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const readable = Boolean(paper?.id && paper && ["READY", "PARTIAL"].includes(paper.status));
  const paperScopeId = paper?.id ? `paper:${paper.id}` : "paper:none";
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
  const figureAnalysisQuery = useQuery({
    queryKey: ["figure-analyses", root, paper?.id],
    queryFn: () => listFigureAnalyses(root, paper!.id),
    enabled: readable,
    retry: false,
  });
  const annotationQuery = useQuery({
    queryKey: ["reader-annotations", root, paper?.id],
    queryFn: () => listReaderAnnotations(root, paper!.id),
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
    queryKey: ["context-draft", root, paperScopeId],
    queryFn: () => getContextDraft(root, paperScopeId),
    enabled: readable,
    retry: false,
  });
  const promptTemplatesQuery = useQuery({
    queryKey: ["prompt-templates", root],
    queryFn: () => listPromptTemplates(root),
    enabled: Boolean(root),
    retry: false,
  });
  const sections = useMemo(
    () => buildReaderSections(documentQuery.data, markdownQuery.data ?? ""),
    [documentQuery.data, markdownQuery.data],
  );
  const persistedTranslations = useMemo(
    () => Object.fromEntries((translationQuery.data ?? []).map((record) => [record.blockId, { status: "saved", text: record.translatedText, segments: record.segments, terms: record.terms, kind: record.promptVersion.startsWith(WORD_LOOKUP_PROMPT_VERSION) ? "word" : "passage", record } satisfies TranslationState])),
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
  const promptTemplates = promptTemplatesQuery.data ?? [];
  const readerPrompt = resolvePromptTemplate(promptTemplates, "reader", readerPromptId);
  const translationPrompt = resolvePromptTemplate(promptTemplates, "translation", translationPromptId);
  const explanationPrompt = resolvePromptTemplate(promptTemplates, "explanation", explanationPromptId);
  const markdownPrompt = resolvePromptTemplate(promptTemplates, "markdown", markdownPromptId);
  const markdownPromptVersion = `${MARKDOWN_FORMAT_PROMPT_VERSION}:${markdownPrompt?.id ?? "default"}`;
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
    setPdfPage(1);
    setPdfNavigationKey(0);
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
    window.localStorage.setItem(READER_OUTLINE_WIDTH_KEY, String(outlineWidth));
  }, [outlineWidth]);

  useEffect(() => window.localStorage.setItem(READER_OUTLINE_COLLAPSED_KEY, String(outlineCollapsed)), [outlineCollapsed]);
  useEffect(() => window.localStorage.setItem(READER_AGENT_WIDTH_KEY, String(agentWidth)), [agentWidth]);
  useEffect(() => window.localStorage.setItem(READER_AGENT_COLLAPSED_KEY, String(agentCollapsed)), [agentCollapsed]);

  useEffect(() => {
    if (!readable || !paper || !contextDraftQuery.isSuccess) return;
    const initializedKey = `p2i.paper-context-initialized:${paper.id}`;
    if (window.localStorage.getItem(initializedKey)) return;
    window.localStorage.setItem(initializedKey, "true");
    if (contextDraftQuery.data.items.length) return;
    void addPaperToContext(root, paper.id, "full", paperScopeId)
      .then((draft) => queryClient.setQueryData(["context-draft", root, paperScopeId], draft))
      .catch((error) => setContextNotice(error instanceof Error ? error.message : String(error)));
  }, [contextDraftQuery.data, contextDraftQuery.isSuccess, paper?.id, paperScopeId, queryClient, readable, root]);

  useEffect(() => {
    const canvas = readerCanvas.current;
    if (!canvas) return;
    const zoomOnWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      setReaderZoom(readerZoom + (event.deltaY < 0 ? 5 : -5));
    };
    canvas.addEventListener("wheel", zoomOnWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", zoomOnWheel);
  }, [readerZoom, setReaderZoom]);

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
    const key = `${paper.id}:${document.source_sha256}:${formattingModel.id}:${markdownPromptVersion}`;
    if (document.formatting?.model_id === formattingModel.id && document.formatting.prompt_version === markdownPromptVersion) return;
    if (autoFormattingKey.current === key) return;
    autoFormattingKey.current = key;
    void formatDocument();
  }, [autoFormatMarkdown, documentQuery.data, formattingCredentialReady, formattingModel?.id, formattingProvider?.id, markdownPromptVersion, paper?.id]);

  const choosePrompt = (category: PromptTemplateCategory, id: string) => {
    selectPromptTemplate(category, id);
    if (category === "reader") setReaderPromptId(id);
    else if (category === "translation") setTranslationPromptId(id);
    else if (category === "explanation") setExplanationPromptId(id);
    else if (category === "markdown") setMarkdownPromptId(id);
  };

  const toggleFocusMode = async (enabled: boolean) => {
    setReaderFocusMode(enabled);
    if (enabled) {
      setMode("integrated");
      setAgentOpen(true);
      setAgentCollapsed(false);
    }
    if (nativeRuntime) {
      try {
        await getCurrentWindow().setFullscreen(enabled);
      } catch {
        // The layout still enters focus mode if the window manager rejects fullscreen.
      }
    }
  };

  useEffect(() => {
    const exitOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && readerFocusMode) void toggleFocusMode(false);
    };
    window.addEventListener("keydown", exitOnEscape);
    return () => window.removeEventListener("keydown", exitOnEscape);
  }, [readerFocusMode]);

  if (!paper) return <main className="reader-empty"><BookOpen size={34} /><h2>尚未选择论文</h2><p>请先在论文库中选择一篇论文，再用阅读器打开。</p><button className="primary-button compact" onClick={() => setView("library")}>打开论文库</button></main>;

  const credentialReady = !nativeRuntime || Boolean(selectedProvider && providerCredentialQuery.data?.some(
    (summary) => summary.credentialId === selectedProvider.credentialId && summary.configured,
  ));

  const updateTranslation = (blockId: string, update: (current: TranslationState) => TranslationState) => {
    setTranslations((current) => ({
      ...current,
      [blockId]: update(current[blockId] ?? { status: "streaming", text: "" }),
    }));
  };

  const paperWordContextFor = (block: ReaderBlock) => {
    const section = sections.find((candidate) => candidate.id === block.sectionId);
    const allBlocks = sections.flatMap((candidate) => candidate.blocks);
    const index = allBlocks.findIndex((candidate) => candidate.id === block.id || candidate.text.includes(block.text));
    const adjacentText = index >= 0
      ? allBlocks.slice(Math.max(0, index - 2), index + 3).map((candidate) => candidate.text).join("\n\n")
      : block.text;
    return {
      paperTitle: paper.title,
      sectionTitle: section?.title ?? block.sectionId,
      outline: sections.map((candidate) => candidate.title),
      selectedParagraph: allBlocks.find((candidate) => candidate.id === block.id)?.text ?? adjacentText,
      adjacentText: adjacentText.slice(0, 8_000),
      paperExcerpt: (markdownQuery.data ?? sections.flatMap((candidate) => candidate.blocks.map((item) => item.text)).join("\n\n")).slice(0, 20_000),
    };
  };

  const translate = async (block: ReaderBlock) => {
    const kind = "kind" in block && block.kind === "word" ? "word" : "passage";
    if (!selectedModel || !selectedProvider || !credentialReady) {
      setTranslations((current) => ({ ...current, [block.id]: { status: "error", text: "", kind, error: "请先在设置中配置所选模型的 API Key。" } }));
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
    setTranslations((current) => ({ ...current, [block.id]: { status: "streaming", text: "", kind } }));
    const requestId = crypto.randomUUID();
    const onEvent = (event: ModelStreamEvent) => {
      if (event.kind === "delta" && event.text) {
        updateTranslation(block.id, (current) => kind === "word"
          ? ({ ...current, status: "streaming", text: current.text + event.text })
          : ({ ...current, status: "streaming", raw: (current.raw ?? "") + event.text }));
      } else if (event.kind === "done") {
        updateTranslation(block.id, (current) => {
          if (kind === "word") return { ...current, status: "unsaved" };
          const parsed = parseStructuredTranslation(block.text, current.raw ?? "");
          return { ...current, status: "unsaved", text: parsed.translatedText, segments: parsed.segments, terms: parsed.terms };
        });
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
        messages: kind === "word" ? buildWordLookupMessages(block.text, paperWordContextFor(block)).map((message, index) => index === 0 ? { ...message, content: `${translationPrompt?.content ?? ""}\n\n${message.content}` } : message) : [
          { role: "system", content: translationPrompt?.content ?? "请将科研文本忠实翻译为简体中文，保留公式、术语、引用和数字，只返回译文。" },
          { role: "user", content: structuredTranslationPrompt(block.text) },
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
    const selectedRange = block as Partial<SelectionSource>;
    try {
      const record = await saveTranslation(root, {
        paperId: paper.id,
        sectionId: block.sectionId,
        blockId: block.id,
        sourceText: block.text,
        translatedText: state.text,
        sourceStart: selectedRange.start ?? 0,
        sourceEnd: selectedRange.end ?? block.text.length,
        segments: state.segments ?? [],
        terms: state.terms ?? [],
        targetLanguage: "zh-CN",
        modelId: selectedModel.id,
        promptVersion: `${state.kind === "word" ? WORD_LOOKUP_PROMPT_VERSION : TRANSLATION_PROMPT_VERSION}:${translationPrompt?.id ?? "default"}`,
      });
      setTranslations((current) => ({ ...current, [block.id]: { status: "saved", text: record.translatedText, segments: record.segments, terms: record.terms, record } }));
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
          { role: "system", content: `${explanationPrompt?.content ?? "请用中文严谨解释给定科研内容，并引用来源锚点。"}\n\n${type === "formula" ? "本次重点解释公式：定义每个符号、量纲、运算、作用、假设和歧义，保留 LaTeX。" : "本次重点解释论断或定理：说明命题、假设、推理概要、影响和局限。"}` },
          { role: "user", content: `来源锚点：paper=${paper.id}, section=${block.sectionId}, block=${block.id}, page=${block.page ?? "未知"}\n\n目标原文：\n${block.text}\n\n相邻结构化上下文：\n${adjacentContext}` },
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
        promptVersion: `${ANALYSIS_PROMPT_VERSION}:${explanationPrompt?.id ?? "default"}`,
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

  const compressContextForChat = async (item: ContextDraftItem): Promise<string> => {
    const model = customModels.find((candidate) => candidate.id === contextCompressionModelId);
    const provider = providers.find((candidate) => candidate.id === model?.providerId);
    const providerReady = !nativeRuntime || Boolean(provider && providerCredentialQuery.data?.some(
      (summary) => summary.credentialId === provider.credentialId && summary.configured,
    ));
    if (!model || !provider || !providerReady) throw new Error("论文全文超出当前对话预算，请先在设置中配置可用的上下文压缩模型。");
    const cached = await getContextCompression(root, item.id, model.id, CONTEXT_COMPRESSION_PROMPT_VERSION);
    if (cached) {
      const draft = await activateContextCompression(root, item.id, model.id, CONTEXT_COMPRESSION_PROMPT_VERSION, paperScopeId);
      queryClient.setQueryData(["context-draft", root, paperScopeId], draft);
      return cached.compressedText;
    }
    const source = await readContextItem(root, item.id, paperScopeId);
    const budgetError = contextCompressionBudgetError(source.estimatedTokens, model.maxContextTokens, model.maxOutputTokens);
    if (budgetError) throw new Error(budgetError);
    const started = performance.now();
    let output = "";
    const usage = await new Promise<{ inputTokens?: number; outputTokens?: number }>((resolve, reject) => {
      let handle: ModelStreamHandle | undefined;
      const onEvent = (event: ModelStreamEvent) => {
        if (event.kind === "delta" && event.text) output += event.text;
        if (event.kind === "done") { handle?.dispose(); resolve(event.usage ?? {}); }
        else if (event.kind === "cancelled") { handle?.dispose(); reject(new Error("上下文压缩已取消。")); }
        else if (event.kind === "error") { handle?.dispose(); reject(new Error(event.error ?? "上下文压缩失败。")); }
      };
      void startModelStream({ requestId: crypto.randomUUID(), provider, model, temperature: 0.1, messages: contextCompressionMessages(source) }, onEvent)
        .then((created) => { handle = created; })
        .catch(reject);
    });
    if (!output.trim()) throw new Error("上下文压缩模型返回了空内容。");
    const record = await saveContextCompression(root, {
      itemId: item.id, sourceHash: item.sourceHash, compressedText: output.trim(), modelId: model.id,
      promptVersion: CONTEXT_COMPRESSION_PROMPT_VERSION, inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens, durationMs: Math.round(performance.now() - started),
    });
    const draft = await activateContextCompression(root, item.id, model.id, CONTEXT_COMPRESSION_PROMPT_VERSION, paperScopeId);
    queryClient.setQueryData(["context-draft", root, paperScopeId], draft);
    return record.compressedText;
  };

  const assembleChatContext = async (): Promise<{ snapshot: ContextSnapshot; contextText: string }> => {
    const draft = await getContextDraft(root, paperScopeId);
    const snapshotItems: ContextSnapshot["items"] = [];
    const content: string[] = [];
    const availableTokens = Math.max(16_000, (selectedModel?.maxContextTokens ?? 128_000) - (selectedModel?.maxOutputTokens ?? 4_096) - 20_000);
    const requiresCompression = draft.items.reduce((total, item) => total + item.estimatedTokens, 0) > availableTokens;
    for (const item of draft.items) {
      const source = await readContextItem(root, item.id, paperScopeId);
      let sourceText = source.sourceText;
      let effectiveMode = item.mode;
      if (item.mode === "compressed" && item.compression) {
        const compression = await getContextCompression(root, item.id, item.compression.modelId, item.compression.promptVersion);
        if (compression) sourceText = compression.compressedText;
      } else if (requiresCompression && item.itemType === "markdown" && !item.sectionId && !item.blockId) {
        sourceText = await compressContextForChat(item);
        effectiveMode = "compressed";
      }
      content.push(`## ${item.paperTitle}${item.sectionId ? ` / ${item.sectionId}` : ""}\n${sourceText}`);
      snapshotItems.push({
        contextItemId: item.id,
        paperId: item.paperId,
        sourceHash: item.sourceHash,
        mode: effectiveMode,
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
        mode: "full",
        sectionIds: [],
        figureIds: [],
        estimatedTokens: Math.ceil(new TextEncoder().encode(sourceText).length / 4),
      });
    }
    return {
      contextText: content.join("\n\n"),
      snapshot: {
        id: crypto.randomUUID(),
        agentProfileId: "reader-paper-analyst",
        modelId: selectedModel?.id ?? "",
        items: snapshotItems,
        tokenBreakdown: draft.tokenBreakdown,
        promptVersion: `${CHAT_PROMPT_VERSION}:${readerPrompt?.id ?? "default"}`,
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
          promptVersion: `${CHAT_PROMPT_VERSION}:${readerPrompt?.id ?? "default"}`,
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
          { role: "system", content: readerPrompt?.content ?? "请默认使用中文，只根据提供的本地论文上下文回答并引用证据锚点。" },
          ...priorMessages,
          { role: "user", content: `问题：${userMessage}\n\n当前本地研究上下文：\n${assembled.contextText}` },
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
      const draft = await addSelectionToContext(root, { paperId: paper.id, sectionId, blockId, sourceText, scopeId: paperScopeId, title: blockId?.startsWith(("ai-")) || blockId?.startsWith("chat:") ? "AI 结果" : "论文选区" });
      queryClient.setQueryData(["context-draft", root, paperScopeId], draft);
      setContextNotice("已加入右侧上下文");
      window.setTimeout(() => setContextNotice(""), 2_400);
    } catch (error) {
      setContextNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setContextBusy("");
    }
  };
  const togglePaperContext = async () => {
    if (!paper) return;
    setContextBusy("paper");
    try {
      const draft = fullText
        ? await removePaperFromContext(root, paper.id, paperScopeId)
        : await addPaperToContext(root, paper.id, "full", paperScopeId);
      queryClient.setQueryData(["context-draft", root, paperScopeId], draft);
    } finally {
      setContextBusy("");
    }
  };
  const editContextItem = async (itemId: string) => {
    try {
      const item = await readContextItem(root, itemId, paperScopeId);
      setContextEditor({ itemId, title: "title" in item ? String(item.title ?? "自定义上下文") : "自定义上下文", text: item.sourceText });
    } catch (error) {
      setContextNotice(error instanceof Error ? error.message : String(error));
    }
  };
  const saveContextItem = async () => {
    if (!contextEditor?.text.trim()) return;
    const draft = await upsertScopedContextItem(root, { scopeId: paperScopeId, paperId: paper.id, itemId: contextEditor.itemId, title: contextEditor.title, text: contextEditor.text });
    queryClient.setQueryData(["context-draft", root, paperScopeId], draft);
    setContextEditor(null);
  };
  const deleteContextItem = async (itemId: string) => {
    const draft = await deleteScopedContextItem(root, paperScopeId, itemId);
    queryClient.setQueryData(["context-draft", root, paperScopeId], draft);
  };
  const restorePaperContext = async () => {
    const draft = await resetContextScope(root, paperScopeId);
    queryClient.setQueryData(["context-draft", root, paperScopeId], draft);
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
        { role: "system", content: `${markdownPrompt?.content ?? "请无损整理科研 Markdown 的结构和换行。"}\n\n必须原样保留每个 [[P2I_EVIDENCE_ANCHOR_N]] 占位符，只返回 Markdown，不要使用代码围栏。` },
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
        promptVersion: markdownPromptVersion,
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
      id: `${block.id}:selection:${start}:${end}`,
      text: text.slice(0, 2000),
      start,
      end,
      left: Math.max(120, Math.min(window.innerWidth - 120, center)),
      top: placeAbove ? (rect?.top ?? event.clientY) - 8 : (rect?.bottom ?? event.clientY) + 8,
      placement: placeAbove ? "above" : "below",
      kind: isSingleEnglishWord(text) ? "word" : "passage",
    });
  };

  const askAboutSelection = async (selected: SelectionSource) => {
    await saveReaderAnnotation(root, {
      paperId: paper.id,
      sectionId: selected.sectionId,
      blockId: selected.id.split(":selection:")[0],
      sourceStart: selected.start,
      sourceEnd: selected.end,
      annotationType: "chat",
      relatedId: selected.id,
    });
    await annotationQuery.refetch();
    await addContext(selected.sectionId, `selection:${selected.id}`, selected.text);
    setChatInput(`请结合论文全文解释这段内容：\n\n“${selected.text}”\n\n`);
    setAgentOpen(true);
    setAgentCollapsed(false);
    setSelection(null);
  };

  const navigateToSection = (section: ReaderSection) => {
    setActiveSection(section.id);
    if (mode === "pdf") {
      setPdfPage(section.pageStart ?? 1);
      setPdfNavigationKey((current) => current + 1);
      return;
    }
    if (mode !== "integrated") setMode("integrated");
    window.requestAnimationFrame(() => {
      document.getElementById(`reader-section-${section.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  const changeMode = (nextMode: ReaderMode) => {
    setMode(nextMode);
    if (nextMode === "pdf") {
      const section = sections.find((candidate) => candidate.id === activeSection) ?? sections[0];
      setPdfPage(section?.pageStart ?? 1);
      setPdfNavigationKey((current) => current + 1);
    } else if (nextMode === "integrated" && activeSection) {
      window.requestAnimationFrame(() => {
        document.getElementById(`reader-section-${activeSection}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  };

  const resizeOutline = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = outlineDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setOutlineWidth(clampOutlineWidth(drag.startWidth + event.clientX - drag.startX));
  };

  const finishOutlineResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (outlineDrag.current?.pointerId !== event.pointerId) return;
    outlineDrag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const resizeOutlineWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setOutlineWidth((current) => clampOutlineWidth(current + (event.key === "ArrowRight" ? 16 : -16)));
  };

  const resizeAgent = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = agentDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setAgentWidth(clampAgentWidth(drag.startWidth + drag.startX - event.clientX));
  };

  const finishAgentResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (agentDrag.current?.pointerId !== event.pointerId) return;
    agentDrag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const resizeAgentWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setAgentWidth((current) => clampAgentWidth(current + (event.key === "ArrowLeft" ? 16 : -16)));
  };

  const speakWord = (word: string) => {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = "en-US";
    utterance.rate = 0.82;
    window.speechSynthesis.speak(utterance);
  };

  const figureForSource = (source?: string) => paper.figures.find((figure) => {
    const normalizedSource = (source ?? "").replace(/\\/g, "/");
    return normalizedSource.endsWith(figure.relativePath.replace(/\\/g, "/"));
  });
  const figureAnalysisFor = (source?: string) => {
    const figure = figureForSource(source);
    const analysis = figureAnalysisQuery.data?.find((item) => item.figureId === figure?.id);
    return analysis && expandedFigures.has(analysis.figureId) ? { ...analysis, id: `${analysis.id}:expanded` } : analysis;
  };
  const toggleFigureAnalysis = async (source?: string) => {
    const figure = figureForSource(source);
    if (!figure) return;
    const analysis = figureAnalysisQuery.data?.find((item) => item.figureId === figure.id);
    if (analysis?.status === "failed") {
      await retryFigureAnalysis(root, paper.id, figure.id);
      await figureAnalysisQuery.refetch();
      return;
    }
    if (analysis?.status !== "completed") {
      setContextNotice("图片解读尚未完成，请在 Activity 中重试预处理。");
      return;
    }
    setExpandedFigures((current) => {
      const next = new Set(current);
      if (next.has(figure.id)) next.delete(figure.id); else next.add(figure.id);
      return next;
    });
  };

  const sourcePdfUrl = assetUrl(paper.sourcePath);
  const pagedPdfUrl = sourcePdfUrl ? `${sourcePdfUrl}#page=${pdfPage}&view=FitH` : "";
  const renderedOutlineWidth = outlineCollapsed ? COLLAPSED_OUTLINE_WIDTH : outlineWidth;
  const renderedAgentWidth = agentCollapsed ? COLLAPSED_AGENT_WIDTH : agentWidth;
  const selectionTranslation = selection ? translations[selection.id] ?? persistedTranslations[selection.id] : undefined;
  const themeColors = readerTheme === "custom"
    ? { background: readerBackgroundColor, text: readerTextColor }
    : READER_THEME_COLORS[readerTheme];
  const updateCustomReaderColor = (kind: "background" | "text", value: string) => {
    const background = kind === "background" ? value : readerBackgroundColor;
    const text = kind === "text" ? value : readerTextColor;
    if (contrastRatio(background, text) < 4.5) {
      setContextNotice("正文颜色对比度过低，请选择更清晰的配色。");
      return;
    }
    setReaderColors(background, text);
  };
  const readerPanelStyle = {
    "--reader-outline-width": `${outlineWidth}px`,
    "--reader-agent-width": `${agentWidth}px`,
    "--reader-zoom": readerZoom / 100,
    "--reader-background": themeColors.background,
    "--reader-text": themeColors.text,
  } as CSSProperties;

  return <div className={`reader-workspace ${readerFocusMode ? "focus-mode" : ""}`} style={readerPanelStyle}>
    {readerFocusMode && <button className="reader-focus-exit" onClick={() => void toggleFocusMode(false)} title="退出纯享模式（Esc）"><Minimize2 size={14} /> 退出纯享</button>}
    {selection && <div ref={selectionToolbar} className={`selection-popover ${selection.placement} ${selectionTranslation ? "with-result" : ""}`} style={{ left: selection.left, top: selection.top }} role="dialog" aria-label={selection.kind === "word" ? "论文语境查词" : "选中文本操作"}>
      <div className="selection-popover-actions"><button title={selection.kind === "word" ? "结合全文语境查词" : "翻译选中文本"} onClick={() => void translate(selection)}><Languages size={14} /> {selection.kind === "word" ? "查词" : "翻译"}</button><button title="在本篇论文的统一对话中提问" onClick={() => void askAboutSelection(selection)}><MessageSquareText size={14} /> 提问</button><button title="解释选中文本" onClick={() => void explain("theorem", selection)}><Sparkles size={14} /> 解释</button>{selection.kind === "word" && <button title="朗读单词" onClick={() => speakWord(selection.text)}><Volume2 size={14} /> 读音</button>}<button className="icon-button" title="关闭" onClick={() => setSelection(null)}><X size={14} /></button></div>
      {selectionTranslation && <TranslationPanel block={selection} state={selectionTranslation} compact onSave={() => void persistTranslation(selection, selectionTranslation)} onRetry={() => void translate(selection)} onCancel={() => void cancelTranslation(selection.id)} onSpeak={selection.kind === "word" ? () => speakWord(selection.text) : undefined} onAddContext={() => void addContext(selection.sectionId, `ai-translation:${selection.id}`, `原文：\n${selection.text}\n\nAI ${selection.kind === "word" ? "论文语境词义" : "翻译"}：\n${selectionTranslation.text}`)} inContext={Boolean(contextDraftQuery.data?.items.some((item) => item.paperId === paper.id && item.blockId === `ai-translation:${selection.id}`))} />}
    </div>}
    {contextNotice && <div className="reader-context-notice"><Check size={13} /> {contextNotice}</div>}
    <div className="reader-toolbar">
      <button onClick={() => setView("library")}><ChevronLeft size={13} /> 论文库</button>
      <strong title={paper.title}>{paper.title}</strong>
      <div className="reader-mode-switch"><button className={mode === "integrated" ? "active" : ""} onClick={() => changeMode("integrated")}>沉浸精读</button><button className={mode === "pdf" ? "active" : ""} onClick={() => changeMode("pdf")}>仅 PDF</button><button className={mode === "figures" ? "active" : ""} onClick={() => changeMode("figures")}>插图</button></div>
      {mode === "integrated" && <div className="reader-display-controls">
        <button className="icon-button" title="缩小正文字号（Ctrl + 滚轮）" onClick={() => setReaderZoom(readerZoom - 5)} disabled={readerZoom <= 80}><Minus size={13} /></button>
        <button title="重置正文字号" onClick={() => setReaderZoom(100)}>{readerZoom}%</button>
        <button className="icon-button" title="放大正文字号（Ctrl + 滚轮）" onClick={() => setReaderZoom(readerZoom + 5)} disabled={readerZoom >= 180}><Plus size={13} /></button>
        <div className="reader-theme-control"><button className={themeMenuOpen ? "active icon-button" : "icon-button"} title="阅读配色" onClick={() => setThemeMenuOpen((value) => !value)}><Palette size={13} /></button>{themeMenuOpen && <div className="reader-theme-menu">
          <strong>阅读配色</strong><div className="reader-theme-presets">{Object.entries(READER_THEME_COLORS).map(([id, colors]) => <button key={id} className={readerTheme === id ? "active" : ""} title={id === "white" ? "白纸" : id === "warm" ? "暖纸" : id === "green" ? "柔绿" : "深色"} style={{ background: colors.background, color: colors.text }} onClick={() => setReaderTheme(id as keyof typeof READER_THEME_COLORS)}>{id === "white" ? "白" : id === "warm" ? "暖" : id === "green" ? "绿" : "暗"}</button>)}</div>
          <label><span>背景</span><input type="color" value={readerBackgroundColor} onChange={(event) => updateCustomReaderColor("background", event.target.value)} /></label><label><span>文字</span><input type="color" value={readerTextColor} onChange={(event) => updateCustomReaderColor("text", event.target.value)} /></label>
        </div>}</div>
        <div className="reader-language-switch"><button className={readerTranslationView === "original" ? "active" : ""} onClick={() => setReaderTranslationView("original")}>原文</button><button className={readerTranslationView === "translated" ? "active" : ""} onClick={() => setReaderTranslationView("translated")}>译文</button></div>
      </div>}
      <button className="reader-focus-button" onClick={() => void toggleFocusMode(true)} title="只保留目录、Markdown 正文和论文阅读助手"><Maximize2 size={13} /> 纯享阅读</button>
      <button><Search size={13} /> 查找</button>
      <div className="reader-prompt-control"><button className={promptPickerOpen ? "active" : ""} onClick={() => setPromptPickerOpen((value) => !value)}><BookOpenText size={13} /> AI 模板</button>{promptPickerOpen && <div className="reader-prompt-picker">
        {(["translation", "explanation", "markdown"] as PromptTemplateCategory[]).map((category) => {
          const label = category === "translation" ? "翻译" : category === "explanation" ? "解释" : "Markdown 整理";
          const selected = category === "translation" ? translationPrompt : category === "explanation" ? explanationPrompt : markdownPrompt;
          return <label key={category}><span>{label}</span><select value={selected?.id ?? ""} onChange={(event) => choosePrompt(category, event.target.value)}>{promptTemplates.filter((template) => template.category === category).map((template) => <option value={template.id} key={template.id}>{template.name}</option>)}</select></label>;
        })}
        <button className="reader-prompt-manage" onClick={() => setView("agents")}>管理提示词</button>
      </div>}</div>
      <button className={formattingStatus === "saved" ? "active" : ""} disabled={formattingStatus === "formatting"} title={formattingError || `使用 ${formattingModel?.displayName ?? "所选模型"} 与 ${markdownPrompt?.name ?? "默认提示词"} 整理 Markdown`} onClick={() => void formatDocument()}>{formattingStatus === "formatting" ? <LoaderCircle className="spin" size={13} /> : <WandSparkles size={13} />} {formattingStatus === "formatting" ? `${formattingProgress}%` : "整理"}</button><button className={fullText ? "active" : ""} disabled={contextBusy === "paper"} onClick={() => void togglePaperContext()}><Layers3 size={13} /> {fullText ? `MD 上下文 · ${contextPercent}%` : "加入 MD 原文"}</button><button className="reader-agent-toggle" onClick={() => { setAgentOpen(true); setAgentCollapsed(false); }}><Bot size={13} /> 询问 AI</button>
    </div>
    <div className="reader-main">
      <aside className={`reader-outline ${outlineCollapsed ? "collapsed" : ""}`} style={{ width: renderedOutlineWidth, flexBasis: renderedOutlineWidth }}>
        {outlineCollapsed ? <button className="reader-panel-expand" title="展开章节目录" onClick={() => setOutlineCollapsed(false)}><PanelLeftOpen size={16} /><span>目录</span></button> : <div className="reader-outline-scroll"><div className="reader-outline-heading"><span className="reader-outline-title">{mode === "pdf" ? `PDF 目录 · 第 ${pdfPage} 页` : "章节目录"}</span><button title="收起章节目录" onClick={() => setOutlineCollapsed(true)}><PanelLeftClose size={14} /></button></div>{sections.map((section, index) => <button key={section.id} className={activeSection === section.id ? "active" : ""} style={{ paddingLeft: `${10 + Math.max(0, section.level - 1) * 12}px` }} onClick={() => navigateToSection(section)}><b>{String(index + 1).padStart(2, "0")}</b><span>{section.title}</span><small>{section.pageStart ? section.pageStart === section.pageEnd ? `第 ${section.pageStart} 页` : `第 ${section.pageStart}-${section.pageEnd} 页` : `${section.blocks.length}`}</small></button>)}</div>}
        {!outlineCollapsed && <div className="reader-outline-resizer" role="separator" aria-label="调整目录宽度" aria-orientation="vertical" aria-valuemin={MIN_OUTLINE_WIDTH} aria-valuemax={MAX_OUTLINE_WIDTH} aria-valuenow={outlineWidth} tabIndex={0} title="拖动调整目录宽度" onPointerDown={(event) => { event.preventDefault(); event.currentTarget.focus(); outlineDrag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: outlineWidth }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={resizeOutline} onPointerUp={finishOutlineResize} onPointerCancel={finishOutlineResize} onKeyDown={resizeOutlineWithKeyboard} />}
      </aside>
      <main className={`reader-canvas reader-theme-${readerTheme}`} ref={readerCanvas}>
        {mode === "integrated" && <article className="integrated-paper">
          <header className="paper-reading-header"><span className="tag tag-primary">MD 章节阅读</span><h1>{paper.title}</h1><p>本地文档 · {paper.pageCount || "—"} 页 · 更新于 {new Date(paper.updatedAt).toLocaleDateString("zh-CN")}</p></header>
          {formattingStatus === "error" && <div className="formatting-notice error"><TriangleAlert size={13} /> {formattingError}</div>}
          {markdownQuery.isLoading || documentQuery.isLoading ? <div className="document-loading">Loading structured document…</div> : sections.map((section, sectionIndex) => {
            const displayBlocks = compactReaderBlocks(section.blocks);
            return <section id={`reader-section-${section.id}`} data-section-id={section.id} className={`reading-section ${activeSection === section.id ? "active" : ""}`} key={section.id}>
            <header><div className="section-heading"><span className="section-kicker">章节 {String(sectionIndex + 1).padStart(2, "0")}</span><h2>{section.title}</h2><span>{section.pageStart ? section.pageStart === section.pageEnd ? `第 ${section.pageStart} 页` : `第 ${section.pageStart}-${section.pageEnd} 页` : "结构化内容"}</span></div><button disabled={contextBusy === section.id} onClick={() => void addContext(section.id, undefined, section.blocks.map((block) => block.text).join("\n\n"))}><Layers3 size={12} /> {contextDraftQuery.data?.items.some((item) => item.paperId === paper.id && item.sectionId === section.id && !item.blockId) ? "已添加" : "添加章节"}</button></header>
            <div className="paragraph-stack">{displayBlocks.map((block) => {
              const state = translations[block.id] ?? persistedTranslations[block.id];
              const hasFormula = /\$|\\\[|\\begin\{equation/.test(block.text);
              const explanationType = activeAnalysis?.blockId === block.id ? activeAnalysis.type : hasFormula ? "formula" : "theorem";
              const explanation = analysisStates[analysisKey(block.id, explanationType)] ?? persistedAnalyses[analysisKey(block.id, explanationType)];
              return <div className={`paragraph-card ${block.compacted ? "compacted" : ""} ${activeBlock === block.id ? "active" : ""}`} key={block.id} onClick={(event) => { if (!(event.target as HTMLElement).closest("button, a")) setActiveBlock((current) => current === block.id ? "" : block.id); }} onMouseUp={(event) => captureSelection(block, event)}>
                <div className="paragraph-main"><div className="paragraph-markdown"><BilingualBlock block={block} state={state} view={readerTranslationView} markdownPath={paper.markdownPath} chatAnnotated={Boolean(contextDraftQuery.data?.items.some((item) => item.paperId === paper.id && item.blockId === block.id) || annotationQuery.data?.some((item) => item.blockId === block.id && item.annotationType === "chat"))} figureAnalysisFor={figureAnalysisFor} onToggleFigure={(source) => void toggleFigureAnalysis(source)} /></div></div>
                <div className="paragraph-actions"><button className={state?.text ? "active" : ""} title={state?.status === "streaming" ? "停止翻译" : "翻译本段"} aria-label="翻译本段" onClick={() => void (state?.status === "streaming" ? cancelTranslation(block.id) : translate(block))}>{state?.status === "streaming" ? <LoaderCircle className="spin" size={14} /> : <Languages size={14} />}</button>{state?.status === "unsaved" && <button title="保存句子级译文" onClick={() => void persistTranslation(block, state)}><Check size={14} /></button>}<button title={hasFormula ? "解释公式" : "解释段落"} aria-label={hasFormula ? "解释公式" : "解释段落"} onClick={() => void explain(hasFormula ? "formula" : "theorem", block)}><Sparkles size={14} /></button><button className={contextDraftQuery.data?.items.some((item) => item.paperId === paper.id && item.blockId === block.id) ? "active" : ""} title="加入论文上下文" aria-label="加入论文上下文" disabled={contextBusy === block.id} onClick={() => void addContext(block.sectionId, block.id, block.text)}><Layers3 size={14} /></button></div>
                {state?.error && <p className="paragraph-translation-error"><TriangleAlert size={12} /> {state.error}</p>}
                {explanation && <AnalysisCard block={block} type={explanationType} state={explanation} onSave={() => void persistAnalysis(block, explanationType, explanation)} onRetry={() => void explain(explanationType, block)} onCancel={() => void streamHandles.current.get(`analysis:${analysisKey(block.id, explanationType)}`)?.cancel()} onFollowUp={() => { setChatInput(`继续追问 ${block.sectionId}/${block.id} 的${explanationType === "formula" ? "公式" : "论述"}解释：`); setAgentOpen(true); setAgentCollapsed(false); }} onAddContext={() => void addContext(block.sectionId, `ai-analysis:${explanationType}:${block.id}`, `用户分析对象：\n${block.text}\n\nAI ${explanationType === "formula" ? "公式解释" : "论述解释"}：\n${explanation.text}`)} inContext={Boolean(contextDraftQuery.data?.items.some((item) => item.paperId === paper.id && item.blockId === `ai-analysis:${explanationType}:${block.id}`))} />}
              </div>;
            })}</div>
          </section>;})}
        </article>}
        {mode === "pdf" && <div className="integrated-pdf">{pagedPdfUrl ? <iframe key={`${pdfPage}:${pdfNavigationKey}`} title={`Source PDF · page ${pdfPage}`} src={pagedPdfUrl} /> : <div className="pdf-placeholder"><FileText size={38} /><h2>无法预览 PDF</h2><p>源 PDF 路径当前不可用。</p></div>}</div>}
        {mode === "figures" && <div className="reader-figures">{paper.figures.length ? paper.figures.map((figure) => {
          const analysis = figureAnalysisQuery.data?.find((item) => item.figureId === figure.id);
          const source = figure.relativePath;
          return <figure key={figure.id}>{assetUrl(`${paper.markdownPath?.replace(/[\\/][^\\/]+$/, "")}/${figure.relativePath}`) ? <img src={assetUrl(`${paper.markdownPath?.replace(/[\\/][^\\/]+$/, "")}/${figure.relativePath}`)} alt={figure.caption ?? "提取的插图"} /> : <div><FileImage size={32} /></div>}<figcaption>{figure.caption ?? "提取的插图"}</figcaption><button className={`figure-ai-button ${analysis?.status ?? "pending"}`} onClick={() => void toggleFigureAnalysis(source)}><Sparkles size={13} /> {analysis?.status === "completed" ? (expandedFigures.has(figure.id) ? "收起图解" : "AI 图解") : analysis?.status === "failed" ? "重试图解" : "图解待处理"}</button>{analysis?.description && expandedFigures.has(figure.id) && <div className="figure-ai-description"><MarkdownBlock value={analysis.description} /></div>}</figure>;
        }) : <div className="pdf-placeholder"><FileImage size={36} /><h2>暂无提取的插图</h2><p>解析器完成图像提取后，插图会显示在这里。</p></div>}</div>}
      </main>
      <aside className={`reader-agent-panel ${agentOpen ? "open" : ""} ${agentCollapsed ? "collapsed" : ""}`} style={{ width: renderedAgentWidth, flexBasis: renderedAgentWidth }}>
        {!agentCollapsed && <div className="reader-agent-resizer" role="separator" aria-label="调整论文助手宽度" aria-orientation="vertical" aria-valuemin={MIN_AGENT_WIDTH} aria-valuemax={MAX_AGENT_WIDTH} aria-valuenow={agentWidth} tabIndex={0} title="拖动调整论文助手宽度" onPointerDown={(event) => { event.preventDefault(); event.currentTarget.focus(); agentDrag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: agentWidth }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={resizeAgent} onPointerUp={finishAgentResize} onPointerCancel={finishAgentResize} onKeyDown={resizeAgentWithKeyboard} />}
        <header><Bot size={15} /><strong>论文分析助手</strong><span className={`tag ${credentialReady ? "tag-success" : "tag-warning"}`}>{credentialReady ? "接口就绪" : selectedProvider ? "缺少密钥" : "缺少模型"}</span><button className="reader-agent-collapse" title={agentCollapsed ? "展开论文助手" : "收起论文助手"} onClick={() => setAgentCollapsed((value) => !value)}>{agentCollapsed ? <PanelRightOpen size={14} /> : <PanelRightClose size={14} />}</button><button className="reader-agent-close" title="关闭助手" onClick={() => setAgentOpen(false)}><ChevronLeft size={13} /></button></header>
        {!agentCollapsed && <div className="agent-panel-scroll">
          <div className="agent-chat-summary"><div><strong>本篇论文上下文</strong><b>{contextPercent}%</b></div><div className="context-track"><i style={{ width: `${contextPercent}%` }} /></div><span>{(contextUsed / 1000).toFixed(1)}K / {(maxContextTokens / 1000).toFixed(0)}K · {contextDraftQuery.data?.items.length ?? 0} 项</span><button className={contextManagerOpen ? "active" : ""} title="管理本篇论文上下文" onClick={() => setContextManagerOpen((value) => !value)}><Layers3 size={11} /></button>{Boolean(chatQuery.data?.turns.length) && <button title="清空对话" onClick={() => void clearChat()}><Trash2 size={11} /></button>}</div>
          {contextManagerOpen && <section className="paper-context-manager">
            <header><strong>上下文管理</strong><button title="新增自定义文字" onClick={() => setContextEditor({ title: "阅读笔记", text: "" })}><Plus size={12} /></button><button title="恢复默认 Markdown 全文" onClick={() => void restorePaperContext()}><RotateCcw size={12} /></button></header>
            <div className="paper-context-list">{contextDraftQuery.data?.items.map((item) => <article key={item.id}><div><b>{item.title || (item.itemType === "compressed_markdown" ? "AI 压缩后的原文" : item.itemType === "custom" ? "自定义文字" : "MD 原文")}</b><small>{item.estimatedTokens.toLocaleString()} tokens</small></div><p>{item.sourcePreview}</p><footer>{item.itemType === "custom" && <button onClick={() => void editContextItem(item.id)}>编辑</button>}<button className="danger" onClick={() => void deleteContextItem(item.id)}>移除</button></footer></article>)}</div>
            {contextEditor && <div className="paper-context-editor"><input value={contextEditor.title} onChange={(event) => setContextEditor({ ...contextEditor, title: event.target.value })} placeholder="上下文名称" /><textarea value={contextEditor.text} onChange={(event) => setContextEditor({ ...contextEditor, text: event.target.value })} placeholder="输入需要随论文对话携带的自定义文字" /><footer><button onClick={() => setContextEditor(null)}>取消</button><button className="primary" disabled={!contextEditor.text.trim()} onClick={() => void saveContextItem()}>保存</button></footer></div>}
          </section>}
          <label className="agent-model-field"><span>论文分析模型</span><select value={agentModel} onChange={(event) => setAgentModel(event.target.value)}>{customModels.map((model) => <option key={model.id} value={model.id}>{model.displayName} · {providers.find((provider) => provider.id === model.providerId)?.format ?? "不可用"}</option>)}</select></label>
          <label className="agent-model-field"><span>阅读助手提示词</span><select value={readerPrompt?.id ?? ""} onChange={(event) => choosePrompt("reader", event.target.value)}>{promptTemplates.filter((template) => template.category === "reader").map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>
          <div className="agent-chat-thread">
            {!chatQuery.data?.turns.length && chatStatus !== "streaming" && <div className="agent-chat-empty"><MessageSquareText size={18} /><strong>询问这篇论文</strong><span>默认携带本篇 Markdown 原文，并保留每轮上下文快照。</span></div>}
            {(chatQuery.data?.turns ?? []).map((turn) => <div className="agent-chat-turn" key={turn.id}>
              <div className="chat-message user"><span>You</span><p>{turn.userMessage}</p></div>
              <div className={`chat-message assistant ${turn.response?.status ?? "pending"}`}><span>论文分析助手{turn.response ? ` · 修订 ${turn.response.revision}` : ""}</span>{turn.response?.assistantText ? <div className="chat-markdown"><MarkdownBlock value={turn.response.assistantText} /></div> : <p>{turn.response?.error ?? "没有生成回答。"}</p>}<footer><small>{turn.response?.status ?? "等待中"}{turn.response?.usage ? ` · ${turn.response.usage.outputTokens} tokens · ${(turn.response.usage.durationMs / 1000).toFixed(1)}s` : ""}</small><div>{turn.response?.assistantText && <button className={contextDraftQuery.data?.items.some((item) => item.paperId === paper.id && item.blockId === `chat:${turn.id}`) ? "active" : ""} onClick={() => void addContext("reader-chat", `chat:${turn.id}`, `用户问题：\n${turn.userMessage}\n\nAI 回答：\n${turn.response!.assistantText}`)}><Layers3 size={10} /> {contextDraftQuery.data?.items.some((item) => item.paperId === paper.id && item.blockId === `chat:${turn.id}`) ? "已加入" : "加入上下文"}</button>}{turn.response && turn.response.status !== "completed" && <button onClick={() => void sendChat(turn)}><RefreshCw size={10} /> 重试</button>}</div></footer></div>
            </div>)}
            {chatStatus === "streaming" && <div className="agent-chat-turn live"><div className="chat-message user"><span>You</span><p>{chatPendingQuestion}</p></div><div className="chat-message assistant streaming"><span><LoaderCircle className="spin" size={11} /> Paper Analyst</span>{chatLive ? <div className="chat-markdown"><MarkdownBlock value={chatLive} /></div> : <p>Waiting for the first model token…</p>}<footer><button onClick={() => void cancelChat()}><Square size={9} /> Cancel</button></footer></div></div>}
            {chatError && <p className="agent-chat-error"><TriangleAlert size={12} /> {chatError}</p>}
          </div>
        </div>}
        {!agentCollapsed && <form className="agent-chat-input" onSubmit={(event) => { event.preventDefault(); void sendChat(); }}><MessageSquareText size={13} /><input aria-label="询问这篇论文" value={chatInput} onChange={(event) => setChatInput(event.target.value)} disabled={chatStatus === "streaming"} placeholder="输入关于这篇论文的问题…" /><button title="发送" type="submit" disabled={!chatInput.trim() || chatStatus === "streaming"}><Send size={13} /></button></form>}
      </aside>
    </div>
    <footer className="reader-context-bar"><Layers3 size={14} /><strong>本篇论文上下文</strong><span className="tag tag-primary">{contextDraftQuery.data?.items.length ?? 0} 个条目</span><div className="context-track"><i style={{ width: `${contextPercent}%` }} /></div><code>{(contextUsed / 1000).toFixed(1)}K / {(maxContextTokens / 1000).toFixed(0)}K · {contextPercent}%</code><span>与多论文研究上下文独立。</span><button onClick={() => { setAgentOpen(true); setAgentCollapsed(false); setContextManagerOpen(true); }}>管理</button></footer>
  </div>;
}

function TranslationPanel({ block, state, compact = false, onSave, onRetry, onCancel, onSpeak, onAddContext, inContext }: { block: ReaderBlock; state: TranslationState; compact?: boolean; onSave: () => void; onRetry: () => void; onCancel: () => void; onSpeak?: () => void; onAddContext: () => void; inContext: boolean }) {
  const word = state.kind === "word";
  return <div className={`translation-result ${word ? "word-lookup" : ""} ${compact ? "compact" : ""} ${state.status}`} data-block-id={block.id}>
    <div><span className="tag tag-ai">{word ? `论文语境词典 · ${block.text}` : "中文翻译"}{state.record ? ` · 修订 ${state.record.revision}` : ""}</span>{state.status === "saved" && <span className="tag tag-success"><Check size={10} /> 已保存</span>}</div>
    {state.status === "streaming" && !state.text && <p><LoaderCircle className="spin" size={13} /> 正在结合论文全文分析…</p>}
    {state.text && <div className="translation-markdown"><MarkdownBlock value={state.text} /></div>}
    {state.error && <p className="translation-error"><TriangleAlert size={13} /> {state.error}</p>}
    <footer>
      {state.status === "streaming" ? <button onClick={onCancel}><Square size={10} /> 停止</button> : <button onClick={onRetry}><RefreshCw size={11} /> {state.status === "error" ? "重试" : word ? "重新查词" : "重新翻译"}</button>}
      {onSpeak && <button onClick={onSpeak}><Volume2 size={11} /> 朗读</button>}
      {state.status === "unsaved" && <button onClick={onSave}>保存结果</button>}
      {state.text && state.status !== "streaming" && <button className={inContext ? "active" : ""} onClick={onAddContext}><Layers3 size={11} /> {inContext ? "已加入上下文" : "加入上下文"}</button>}
    </footer>
  </div>;
}

function AnalysisCard({ block, type, state, onSave, onRetry, onCancel, onFollowUp, onAddContext, inContext }: { block: ReaderBlock; type: ReaderAnalysisType; state: AnalysisState; onSave: () => void; onRetry: () => void; onCancel: () => void; onFollowUp: () => void; onAddContext: () => void; inContext: boolean }) {
  const title = type === "formula" ? "公式解释" : "论述解释";
  return <div className={`reader-analysis ${type} ${state.status}`} data-block-id={block.id}>
    <div className="reader-analysis-head"><span className="tag tag-ai">AI {title}{state.record ? ` · 修订 ${state.record.revision}` : ""}</span>{state.status === "saved" && <span className="tag tag-success"><Check size={10} /> 已保存</span>}</div>
    {state.status === "streaming" && !state.text && <p className="analysis-wait"><LoaderCircle className="spin" size={13} /> 正在分析论文证据…</p>}
    {state.text && <div className="analysis-markdown"><MarkdownBlock value={state.text} /></div>}
    {state.error && <p className="translation-error"><TriangleAlert size={13} /> {state.error}</p>}
    <div className="analysis-provenance"><code>{block.sectionId}/{block.id}{block.page ? ` · 第 ${block.page} 页` : ""}</code><span>{state.usage.outputTokens} 输出 tokens · {(state.usage.durationMs / 1000).toFixed(1)} 秒</span></div>
    <footer>{state.status === "streaming" ? <button onClick={onCancel}><Square size={10} /> 停止</button> : <button onClick={onRetry}><RefreshCw size={11} /> {state.status === "error" ? "重试" : "重新生成"}</button>}{state.status === "unsaved" && <button onClick={onSave}>保存解释</button>}<button onClick={onFollowUp}><MessageSquareText size={11} /> 继续追问</button>{state.text && state.status !== "streaming" && <button className={inContext ? "active" : ""} onClick={onAddContext}><Layers3 size={11} /> {inContext ? "已加入上下文" : "加入上下文"}</button>}</footer>
  </div>;
}
