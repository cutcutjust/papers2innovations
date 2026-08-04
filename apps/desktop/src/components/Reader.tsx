import type { ContextDraftItem, ContextSnapshot, FigureAnalysis, LibraryPaper, ModelActivityPhase, ModelStreamEvent, PromptTemplateCategory, ReaderAnalysisRecord, ReaderAnalysisType, ReaderAnnotation, ReaderChatTurn, TranslationRecord, TranslationSegment, TranslationTerm } from "@p2i/contracts";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, BookOpenText, Bot, Check, ChevronLeft, Eye, EyeOff, FileImage, FileText, Languages, Layers3, LoaderCircle, Maximize2, MessageSquareText, Minimize2, Minus, Palette, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Plus, RefreshCw, RotateCcw, Search, Send, Sparkles, Square, Trash2, TriangleAlert, Volume2, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { activateContextCompression, addPaperToContext, addSelectionToContext, assetUrl, clearReaderConversation, deleteReaderAnalysis, deleteReaderAnnotation, deleteReaderChatTurn, deleteScopedContextItem, deleteTranslation, getContextCompression, getContextDraft, getReaderConversation, listDocumentUncertainties, listFigureAnalyses, listPromptTemplates, listReaderAnalyses, listReaderAnnotations, listTranslations, nativeRuntime, readContextItem, readDocument, readMarkdown, removePaperFromContext, resetContextScope, retryFigureAnalysis, saveContextCompression, saveReaderAnalysis, saveReaderAnnotation, saveReaderChatTurn, saveTranslation, startModelStream, updatePaperReading, updateReaderChatTurn, upsertScopedContextItem, type ModelStreamHandle } from "../lib/bridge";
import { hydrateProviderCredentials } from "../lib/credentials";
import { buildReaderSections, resolveMarkdownAssetPath, type ReaderDisplaySection, type ReaderDocumentBlock } from "../lib/documentBlocks";
import { normalizeMarkdownMath } from "../lib/markdownMath";
import { CONTEXT_COMPRESSION_PROMPT_VERSION, contextCompressionBudgetError, contextCompressionMessages } from "../lib/contextCompression";
import { contrastRatio, parseStructuredTranslation, projectTranslationSegmentsAcrossBlocks, splitTranslationChunks, structuredTranslationPrompt, translationTermParts, type TranslationBlockProjection } from "../lib/readerTranslation";
import { createReaderAnnotationPlugin, domRangeFromSourceRange, readerTranslationKey, sentenceRangeAtOffset, sourceOffsetFromDomPoint, sourceRangeFromDomRange, type ReaderTranslationRange } from "../lib/readerAnnotations";
import { resolvePromptTemplate, selectedPromptId, selectPromptTemplate } from "../lib/promptTemplates";
import { buildWordLookupMessages, isSingleEnglishWord } from "../lib/wordLookup";
import { useWorkspace } from "../store";
import { completeModelActivity, failModelActivity, markModelActivitySaving } from "../lib/modelActivity";

type ReaderMode = "integrated" | "pdf" | "figures";
type ReaderBlock = ReaderDocumentBlock;
type ReaderSection = ReaderDisplaySection;
type SelectionSource = ReaderBlock & { sourceBlockId: string; sourceBlockText: string; start: number; end: number; left: number; top: number; placement: "above" | "below"; kind: "word" | "passage"; backward?: boolean; hidden?: boolean };
type TranslationState = {
  status: "streaming" | "unsaved" | "saved" | "cancelled" | "error";
  text: string;
  raw?: string;
  segments?: TranslationSegment[];
  terms?: TranslationTerm[];
  kind?: "word" | "passage";
  error?: string;
  record?: TranslationRecord;
  requestId?: string;
  activityPhase?: ModelActivityPhase;
  startedAt?: number;
  receivedCharacters?: number;
  reasoningCharacters?: number;
  slow?: boolean;
};
type AnalysisState = {
  status: "streaming" | "unsaved" | "saved" | "cancelled" | "error";
  text: string;
  adjacentContext: string;
  usage: { inputTokens: number; outputTokens: number; durationMs: number };
  error?: string;
  record?: ReaderAnalysisRecord;
  requestId?: string;
  activityPhase?: ModelActivityPhase;
};
type AnnotationInspectorState = {
  kind: "translation" | "chat";
  relatedId?: string;
  annotationIds: string[];
  left: number;
  top: number;
};
type TermPanelState = { term: TranslationTerm; sentence: string; language: "source" | "translated"; left: number; top: number; pinned: boolean };
type SentenceMenuState = { source: SelectionSource; left: number; top: number };
type AnnotationRail = {
  id: string;
  kind: "translation" | "chat";
  left: number;
  top: number;
  width: number;
  translationKey?: string;
  translationId?: string;
  annotationIds: string[];
  relatedId?: string;
};
type ProjectedTranslationRecord = {
  record: TranslationRecord;
  projections: TranslationBlockProjection[];
};

const TRANSLATION_PROMPT_VERSION = "reader-translate-v4";
const WORD_LOOKUP_PROMPT_VERSION = "reader-word-v1";
const ANALYSIS_PROMPT_VERSION = "reader-analysis-v2";
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
  white: { label: "白纸", description: "清晰明亮", background: "#f2f4f7", paper: "#ffffff", surface: "#f7f8fa", text: "#252b35", muted: "#667085", border: "#b9c2cf", control: "#ffffff" },
  warm: { label: "暖纸", description: "柔和米白", background: "#eee8dc", paper: "#fbf7ed", surface: "#f5efe2", text: "#2d2b25", muted: "#6f695b", border: "#c7baa4", control: "#fffaf0" },
  green: { label: "柔绿", description: "低饱和护眼", background: "#e4ece6", paper: "#f2f7f3", surface: "#eaf2ec", text: "#243128", muted: "#607067", border: "#adc0b2", control: "#f8fbf8" },
  dark: { label: "深色", description: "夜间精读", background: "#181c22", paper: "#242a32", surface: "#20262e", text: "#e7ebf1", muted: "#aab3bf", border: "#4b5563", control: "#2b323c" },
} as const;
const analysisKey = (blockId: string, type: ReaderAnalysisType) => `${blockId}:${type}`;

const clampOutlineWidth = (width: number) => Math.min(MAX_OUTLINE_WIDTH, Math.max(MIN_OUTLINE_WIDTH, Math.round(width)));
const clampAgentWidth = (width: number) => Math.min(MAX_AGENT_WIDTH, Math.max(MIN_AGENT_WIDTH, Math.round(width)));

function mixHex(first: string, second: string, secondWeight: number): string {
  const parse = (value: string) => [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
  const left = parse(first);
  const right = parse(second);
  return `#${left.map((channel, index) => Math.round(channel * (1 - secondWeight) + right[index] * secondWeight).toString(16).padStart(2, "0")).join("")}`;
}

function customReaderPalette(background: string, text: string) {
  const dark = contrastRatio(background, "#ffffff") > contrastRatio(background, "#000000");
  return {
    label: "自定义",
    description: "自定义颜色",
    background,
    paper: mixHex(background, dark ? "#ffffff" : "#000000", dark ? 0.08 : 0.025),
    surface: mixHex(background, text, 0.055),
    text,
    muted: mixHex(text, background, 0.36),
    border: mixHex(text, background, 0.64),
    control: mixHex(background, dark ? "#ffffff" : "#000000", dark ? 0.12 : 0.04),
  };
}

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

function BilingualBlock({ block, state, records, annotations, activeTranslationKeys, annotationsVisible, markdownPath, figureAnalysisFor, onToggleFigure, onToggleTranslation, onOpenAnnotation, onOpenTerm, onLeaveTerm, onSentenceContextMenu }: { block: ReaderBlock; state?: TranslationState; records: ProjectedTranslationRecord[]; annotations: ReaderAnnotation[]; activeTranslationKeys: ReadonlySet<string>; annotationsVisible: boolean; markdownPath?: string; figureAnalysisFor?: (source?: string) => FigureAnalysis | undefined; onToggleFigure?: (source?: string) => void; onToggleTranslation: (key: string) => void; onOpenAnnotation: (kind: "translation" | "chat", relatedId: string | undefined, annotationIds: string[], rect: DOMRect) => void; onOpenTerm: (term: TranslationTerm, sentence: string, language: "source" | "translated", rect: DOMRect, pinned: boolean) => void; onLeaveTerm: () => void; onSentenceContextMenu: (block: ReaderBlock, event: ReactMouseEvent<HTMLElement>) => void }) {
  const sourceRef = useRef<HTMLDivElement | null>(null);
  const [rails, setRails] = useState<AnnotationRail[]>([]);
  const translationRanges = useMemo<ReaderTranslationRange[]>(() => {
    const persisted = records.flatMap(({ record, projections }) => {
      return record.segments.flatMap((segment) => {
        const projection = projections.find((candidate) => candidate.segmentId === segment.id);
        if (!projection || projection.status === "stale") return [];
        const terms = record.terms.filter((term) => !term.segmentId || term.segmentId === segment.id).map((term) => ({
          ...term,
          sourceStart: term.sourceStart === undefined ? undefined : projection.sourceStart + Math.max(0, term.sourceStart - segment.sourceStart),
          sourceEnd: term.sourceEnd === undefined ? undefined : projection.sourceStart + Math.max(0, term.sourceEnd - segment.sourceStart),
        }));
        return [{ recordId: record.id, segmentId: segment.id, sourceStart: projection.sourceStart, sourceEnd: projection.sourceEnd, sourceText: block.text.slice(projection.sourceStart, projection.sourceEnd), translatedText: segment.translatedText, terms, anchorStatus: projection.status }];
      });
    });
    const draft = state?.text && state.segments?.length && !state.record ? state.segments.map((segment) => ({ recordId: `draft:${block.id}`, segmentId: segment.id, sourceStart: segment.sourceStart, sourceEnd: segment.sourceEnd, sourceText: segment.sourceText, translatedText: segment.translatedText, terms: state.terms?.filter((term) => !term.segmentId || term.segmentId === segment.id) ?? [], anchorStatus: "exact" as const })) : [];
    return [...persisted, ...draft].sort((left, right) => left.sourceStart - right.sourceStart);
  }, [block.id, block.text, records, state]);
  const annotationPlugin = useMemo(() => createReaderAnnotationPlugin({ source: block.text, activeTranslationKeys, annotationsVisible, translations: translationRanges, annotations }), [activeTranslationKeys, annotations, annotationsVisible, block.text, translationRanges]);
  useLayoutEffect(() => {
    const root = sourceRef.current;
    if (!root || !annotationsVisible) {
      setRails([]);
      return;
    }
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rootRect = root.getBoundingClientRect();
        const next: AnnotationRail[] = [];
        root.querySelectorAll<HTMLElement>("[data-translation-key], [data-chat-annotation-ids]").forEach((element, elementIndex) => {
          const translationKey = element.dataset.translationKey;
          const translationId = element.dataset.translationId;
          const annotationIds = (element.dataset.chatAnnotationIds ?? "").split(",").filter(Boolean);
          if (!translationKey && !annotationIds.length) return;
          const range = document.createRange();
          range.selectNodeContents(element);
          const lineRects = Array.from(range.getClientRects()).filter((rect) => rect.width > 2 && rect.height > 0).sort((left, right) => left.top - right.top || left.left - right.left).reduce<Array<{ left: number; right: number; top: number; bottom: number }>>((merged, rect) => {
            const current = merged.at(-1);
            if (current && Math.abs(current.top - rect.top) < 2 && rect.left <= current.right + 2) {
              current.left = Math.min(current.left, rect.left);
              current.right = Math.max(current.right, rect.right);
              current.bottom = Math.max(current.bottom, rect.bottom);
            } else {
              merged.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
            }
            return merged;
          }, []);
          lineRects.forEach((rect, rectIndex) => {
            const baseTop = rect.bottom - rootRect.top - 4;
            if (translationKey) next.push({ id: `translation:${elementIndex}:${rectIndex}:${translationKey}`, kind: "translation", left: rect.left - rootRect.left, top: baseTop - (annotationIds.length ? 4 : 0), width: rect.right - rect.left, translationKey, translationId, annotationIds: [] });
            if (annotationIds.length) {
              const chatAnnotation = annotations.find((annotation) => annotationIds.includes(annotation.id));
              next.push({ id: `chat:${elementIndex}:${rectIndex}:${annotationIds.join(":")}`, kind: "chat", left: rect.left - rootRect.left, top: baseTop + (translationKey ? 4 : 0), width: rect.right - rect.left, annotationIds, relatedId: chatAnnotation?.relatedId });
            }
          });
        });
        setRails(next);
      });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(root);
    window.addEventListener("resize", measure);
    void document.fonts?.ready.then(measure);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [activeTranslationKeys, annotations, annotationsVisible, annotationPlugin]);
  return <div ref={sourceRef} data-reader-block-id={block.id} className="reader-source range-annotated-source" onContextMenu={(event) => onSentenceContextMenu(block, event)}><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath, annotationPlugin]} rehypePlugins={[rehypeKatex]} components={{
    span: ({ children, ...props }) => {
      const attributes = props as Record<string, unknown>;
      const translationId = String(attributes["data-translation-id"] ?? "");
      const segmentId = String(attributes["data-translation-segment-id"] ?? "");
      const translation = translationRanges.find((range) => range.recordId === translationId && range.segmentId === segmentId);
      const translated = String(attributes["data-translation-active"] ?? "") === "true" && Boolean(translation);
      const spanStart = Number(attributes["data-source-start"]);
      const spanEnd = Number(attributes["data-source-end"]);
      const sourceText = Number.isFinite(spanStart) && Number.isFinite(spanEnd) ? block.text.slice(spanStart, spanEnd) : translation?.sourceText ?? "";
      const renderedText = translated && translation ? translation.translatedText : sourceText;
      const language = translated ? "translated" as const : "source" as const;
      const termParts = translation && renderedText ? translationTermParts(renderedText, translation.terms, language, Number.isFinite(spanStart) ? spanStart : translation.sourceStart) : [];
      const content: ReactNode = translation && termParts.some((part) => part.term)
        ? termParts.map((part, index) => part.term
          ? <button key={`${part.term.text}:${index}`} type="button" className={`translation-term-highlight ${part.term.kind} ${language}`} onPointerEnter={(event) => onOpenTerm(part.term!, translation.sourceText, language, event.currentTarget.getBoundingClientRect(), false)} onPointerLeave={onLeaveTerm} onFocus={(event) => onOpenTerm(part.term!, translation.sourceText, language, event.currentTarget.getBoundingClientRect(), false)} onBlur={onLeaveTerm} onClick={(event) => { event.stopPropagation(); onOpenTerm(part.term!, translation.sourceText, language, event.currentTarget.getBoundingClientRect(), true); }}>{part.text}</button>
          : <span key={`translation-text:${index}`}>{part.text}</span>)
        : translated && translation ? translation.translatedText : children;
      return <span {...props}>{content}</span>;
    },
    img: ({ src, alt }) => {
      const resolved = resolveMarkdownAssetPath(markdownPath, src);
      const rendered = resolved && /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(resolved) ? assetUrl(resolved) : resolved;
      const analysis = figureAnalysisFor?.(src);
      return <span className="markdown-figure-inline"><img className="markdown-paper-figure" src={rendered} alt={alt ?? "Extracted paper figure"} loading="lazy" />{onToggleFigure && <button className={`figure-ai-button ${analysis?.status ?? "pending"}`} onClick={() => onToggleFigure(src)}><Sparkles size={13} /> {analysis?.status === "completed" ? "AI 图解" : analysis?.status === "failed" ? "重试图解" : "图解待处理"}</button>}{analysis?.description && analysis.id.endsWith(":expanded") && <div className="figure-ai-description"><MarkdownBlock value={analysis.description} /></div>}</span>;
    },
  }}>{normalizeMarkdownMath(block.text)}</ReactMarkdown>{annotationsVisible && rails.length > 0 && <div className="reader-annotation-rails" aria-label="正文标注">{rails.map((rail) => <button key={rail.id} type="button" className={`reader-annotation-rail ${rail.kind}`} style={{ left: rail.left, top: rail.top, width: rail.width }} title={rail.kind === "translation" ? "点击切换中英文；右键管理译文" : "点击查看论文问答或解释"} aria-label={rail.kind === "translation" ? "切换该句中英文" : "查看该处论文问答或解释"} onMouseDown={(event) => event.preventDefault()} onContextMenu={(event) => { if (rail.kind !== "translation") return; event.preventDefault(); event.stopPropagation(); onOpenAnnotation("translation", rail.translationId, [], event.currentTarget.getBoundingClientRect()); }} onClick={(event) => { event.stopPropagation(); if (rail.kind === "translation" && rail.translationKey) onToggleTranslation(rail.translationKey); else onOpenAnnotation("chat", rail.relatedId, rail.annotationIds, event.currentTarget.getBoundingClientRect()); }} />)}</div>}</div>;
}

export function Reader({ paper, root }: { paper?: LibraryPaper; root: string }) {
  const { setView, customModels, providers, defaultTextModelId, translationModelId, contextCompressionModelId, readerFocusMode, setReaderFocusMode, fontSize, readerZoom, setReaderZoom, readerTheme, setReaderTheme, readerBackgroundColor, readerTextColor, setReaderColors, readerAnnotationsVisible, setReaderAnnotationsVisible } = useWorkspace();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<ReaderMode>("integrated");
  const [selection, setSelection] = useState<SelectionSource | null>(null);
  const [translations, setTranslations] = useState<Record<string, TranslationState>>({});
  const [translationBatchBusy, setTranslationBatchBusy] = useState(false);
  const [analysisStates, setAnalysisStates] = useState<Record<string, AnalysisState>>({});
  const [activeAnalysis, setActiveAnalysis] = useState<{ blockId: string; type: ReaderAnalysisType } | null>(null);
  const [annotationInspector, setAnnotationInspector] = useState<AnnotationInspectorState | null>(null);
  const [activeTranslationKeys, setActiveTranslationKeys] = useState<Set<string>>(() => new Set());
  const [termPanel, setTermPanel] = useState<TermPanelState | null>(null);
  const [sentenceMenu, setSentenceMenu] = useState<SentenceMenuState | null>(null);
  const [editingTurn, setEditingTurn] = useState<{ turnId: string; question: string } | null>(null);
  const [activeBlock, setActiveBlock] = useState("");
  const [activeSection, setActiveSection] = useState("");
  const [contextBusy, setContextBusy] = useState("");
  const [agentModel, setAgentModel] = useState(defaultTextModelId || customModels[0]?.id || "");
  const [chatInput, setChatInput] = useState("");
  const [chatLive, setChatLive] = useState("");
  const [chatPendingQuestion, setChatPendingQuestion] = useState("");
  const [pendingChatSelection, setPendingChatSelection] = useState<SelectionSource | null>(null);
  const [chatStatus, setChatStatus] = useState<"idle" | "streaming" | "error">("idle");
  const [chatError, setChatError] = useState("");
  const [agentOpen, setAgentOpen] = useState(false);
  const [promptPickerOpen, setPromptPickerOpen] = useState(false);
  const [readerPromptId, setReaderPromptId] = useState(() => selectedPromptId("reader"));
  const [translationPromptId, setTranslationPromptId] = useState(() => selectedPromptId("translation"));
  const [explanationPromptId, setExplanationPromptId] = useState(() => selectedPromptId("explanation"));
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
  const translationSlowTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const chatHandle = useRef<ModelStreamHandle | null>(null);
  const termPanelCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectionToolbar = useRef<HTMLDivElement | null>(null);
  const readerCanvas = useRef<HTMLElement | null>(null);
  const outlineDrag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const agentDrag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const restoredReadingPaperId = useRef("");
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
  const uncertaintyQuery = useQuery({
    queryKey: ["document-uncertainties", root, paper?.id],
    queryFn: () => listDocumentUncertainties(root, paper!.id),
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
  const projectedTranslationsByBlock = useMemo(() => {
    const projected = new Map<string, ProjectedTranslationRecord[]>();
    for (const record of (translationQuery.data ?? []).filter((candidate) => !candidate.promptVersion.startsWith(WORD_LOOKUP_PROMPT_VERSION))) {
      const section = sections.find((candidate) => candidate.id === record.sectionId);
      if (!section) continue;
      const projections = projectTranslationSegmentsAcrossBlocks(record.sourceText, section.blocks, record.segments);
      for (const block of section.blocks) {
        const blockProjections = projections.filter((projection) => projection.status !== "stale" && projection.blockId === block.id);
        if (!blockProjections.length) continue;
        projected.set(block.id, [...(projected.get(block.id) ?? []), { record, projections: blockProjections }]);
      }
    }
    return projected;
  }, [sections, translationQuery.data]);
  const persistedTranslations = useMemo(() => {
    const passageEntries = [...projectedTranslationsByBlock].flatMap(([blockId, records]) => {
      const record = records.find((candidate) => candidate.record.sourceStart === 0 && candidate.record.sourceEnd >= candidate.record.sourceText.length)?.record;
      return record ? [[blockId, { status: "saved", text: record.translatedText, segments: record.segments, terms: record.terms, kind: "passage", record } satisfies TranslationState]] : [];
    });
    const wordEntries = (translationQuery.data ?? []).filter((record) => record.promptVersion.startsWith(WORD_LOOKUP_PROMPT_VERSION)).map((record) => [record.blockId, { status: "saved", text: record.translatedText, segments: record.segments, terms: record.terms, kind: "word", record } satisfies TranslationState]);
    return Object.fromEntries([...passageEntries, ...wordEntries]);
  }, [projectedTranslationsByBlock, translationQuery.data]);
  const selectedModel = customModels.find((model) => model.id === agentModel) ?? customModels.find((model) => model.id === defaultTextModelId) ?? customModels[0];
  const selectedProvider = providers.find((provider) => provider.id === selectedModel?.providerId);
  const translationModel = customModels.find((model) => model.id === translationModelId) ?? customModels.find((model) => model.id === defaultTextModelId) ?? selectedModel;
  const translationProvider = providers.find((provider) => provider.id === translationModel?.providerId);
  const promptTemplates = promptTemplatesQuery.data ?? [];
  const readerPrompt = resolvePromptTemplate(promptTemplates, "reader", readerPromptId);
  const translationPrompt = resolvePromptTemplate(promptTemplates, "translation", translationPromptId);
  const explanationPrompt = resolvePromptTemplate(promptTemplates, "explanation", explanationPromptId);

  useEffect(() => {
    if (!customModels.some((model) => model.id === agentModel)) setAgentModel(defaultTextModelId || customModels[0]?.id || "");
  }, [agentModel, customModels, defaultTextModelId]);
  const maxContextTokens = selectedModel?.maxContextTokens ?? 128000;
  const tokenBreakdown = contextDraftQuery.data?.tokenBreakdown;
  const contextUsed = tokenBreakdown ? Object.values(tokenBreakdown).reduce((total, value) => total + value, 0) : 36000;
  const contextPercent = Math.min(100, Math.round(contextUsed / maxContextTokens * 100));
  const fullText = Boolean(paper && contextDraftQuery.data?.items.some(
    (item) => item.paperId === paper.id && !item.sectionId && !item.blockId,
  ));

  useEffect(() => {
    setTranslations({});
    setAnalysisStates({});
    setSelection(null);
    setActiveBlock("");
    setActiveSection("");
    setActiveAnalysis(null);
    setAnnotationInspector(null);
    setActiveTranslationKeys(new Set());
    setTermPanel(null);
    setEditingTurn(null);
    setChatInput("");
    setChatLive("");
    setChatPendingQuestion("");
    setPendingChatSelection(null);
    setChatStatus("idle");
    setChatError("");
    setAgentOpen(false);
    setPdfPage(1);
    setPdfNavigationKey(0);
    for (const timer of translationSlowTimers.current.values()) clearTimeout(timer);
    translationSlowTimers.current.clear();
    for (const handle of streamHandles.current.values()) void handle.cancel();
    streamHandles.current.clear();
    if (chatHandle.current) {
      void chatHandle.current.cancel();
      chatHandle.current.dispose();
      chatHandle.current = null;
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
    const preferredSection = paper?.lastSectionId && sections.some((section) => section.id === paper.lastSectionId)
      ? paper.lastSectionId
      : sections[0].id;
    setActiveSection((current) => current || preferredSection);
    if (paper && restoredReadingPaperId.current !== paper.id) {
      restoredReadingPaperId.current = paper.id;
      window.requestAnimationFrame(() => document.getElementById(`reader-section-${preferredSection}`)?.scrollIntoView({ block: "start" }));
    }
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
  }, [mode, paper?.id, paper?.lastSectionId, sections]);

  useEffect(() => {
    if (!paper || !readable || !sections.length) return;
    const section = sections.find((candidate) => candidate.id === activeSection) ?? sections[0];
    const sectionIndex = Math.max(0, sections.findIndex((candidate) => candidate.id === section.id));
    const page = mode === "pdf" ? pdfPage : section.pageStart ?? paper.lastPage ?? 1;
    const progress = mode === "pdf" && paper.pageCount > 0
      ? Math.min(1, page / paper.pageCount)
      : Math.min(1, (sectionIndex + 1) / sections.length);
    const timer = window.setTimeout(() => {
      void updatePaperReading(root, paper.id, { progress, lastSectionId: section.id, lastPage: page })
        .then((engagement) => queryClient.setQueryData<LibraryPaper[]>(["papers", root], (current = []) => current.map((item) => item.id === paper.id ? {
          ...item,
          lastOpenedAt: engagement.lastOpenedAt,
          lastReadAt: engagement.lastReadAt,
          lastSectionId: engagement.lastSectionId,
          lastPage: engagement.lastPage,
          readingProgress: engagement.readingProgress,
        } : item)))
        .catch(() => undefined);
    }, 650);
    return () => window.clearTimeout(timer);
  }, [activeSection, mode, paper?.id, paper?.pageCount, pdfPage, queryClient, readable, root, sections]);

  useEffect(() => () => {
    if (termPanelCloseTimer.current) clearTimeout(termPanelCloseTimer.current);
    for (const timer of translationSlowTimers.current.values()) clearTimeout(timer);
    translationSlowTimers.current.clear();
    for (const handle of streamHandles.current.values()) {
      handle.dispose();
      void handle.cancel();
    }
    if (chatHandle.current) {
      chatHandle.current.dispose();
      void chatHandle.current.cancel();
    }
  }, []);

  useEffect(() => {
    setSelection(null);
    setSentenceMenu(null);
    setTermPanel(null);
  }, [paper?.id]);

  useEffect(() => {
    if (!selection) return;
    const dismiss = (event: PointerEvent) => {
      if (selectionToolbar.current?.contains(event.target as Node)) return;
      setSelection(null);
    };
    const dismissOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setSelection(null);
    };
    document.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("keydown", dismissOnEscape);
    };
  }, [selection]);

  useLayoutEffect(() => {
    if (!selection || mode !== "integrated") return;
    let frame = 0;
    const selectionRoot = Array.from(document.querySelectorAll<HTMLElement>("[data-reader-block-id]")).find((element) => element.dataset.readerBlockId === selection.sourceBlockId);
    if (!selectionRoot) return;
    const restore = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          const range = domRangeFromSourceRange(selectionRoot, selection.start, selection.end);
          if (!range) return;
          const nativeSelection = window.getSelection();
          if (nativeSelection) {
            nativeSelection.removeAllRanges();
            if (selection.backward && typeof nativeSelection.setBaseAndExtent === "function") nativeSelection.setBaseAndExtent(range.endContainer, range.endOffset, range.startContainer, range.startOffset);
            else nativeSelection.addRange(range);
          }
          const rect = range.getBoundingClientRect();
          const visible = rect.bottom >= 0 && rect.top <= window.innerHeight;
          const center = rect.width > 0 ? rect.left + rect.width / 2 : selection.left;
          const placeAbove = rect.top > 64;
          const left = Math.max(120, Math.min(window.innerWidth - 120, center));
          const top = placeAbove ? rect.top - 8 : rect.bottom + 8;
          setSelection((current) => current && current.sourceBlockId === selection.sourceBlockId && current.start === selection.start && current.end === selection.end
            ? Math.abs(current.left - left) > 1 || Math.abs(current.top - top) > 1 || current.placement !== (placeAbove ? "above" : "below") || current.hidden !== !visible
              ? { ...current, left, top, placement: placeAbove ? "above" : "below", hidden: !visible }
              : current
            : current);
        });
      });
    };
    restore();
    const observer = new MutationObserver(restore);
    observer.observe(selectionRoot, { childList: true, subtree: true, characterData: true });
    readerCanvas.current?.addEventListener("scroll", restore, { passive: true });
    window.addEventListener("resize", restore);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      readerCanvas.current?.removeEventListener("scroll", restore);
      window.removeEventListener("resize", restore);
    };
  });

  useEffect(() => {
    if (!sentenceMenu) return;
    const dismiss = (event: PointerEvent) => {
      if ((event.target as HTMLElement).closest(".reader-sentence-menu")) return;
      setSentenceMenu(null);
    };
    const dismissOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setSentenceMenu(null);
    };
    document.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("keydown", dismissOnEscape);
    };
  }, [sentenceMenu]);

  useEffect(() => {
    if (!annotationInspector) return;
    const dismiss = (event: PointerEvent) => {
      if ((event.target as HTMLElement).closest(".reader-annotation-inspector, .reader-annotation-rail")) return;
      setAnnotationInspector(null);
      setEditingTurn(null);
    };
    const dismissOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setAnnotationInspector(null);
        setEditingTurn(null);
      }
    };
    document.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("keydown", dismissOnEscape);
    };
  }, [annotationInspector]);

  useEffect(() => {
    if (!termPanel?.pinned) return;
    const dismiss = (event: PointerEvent) => {
      if ((event.target as HTMLElement).closest(".reader-term-panel, .translation-term-highlight")) return;
      setTermPanel(null);
    };
    const dismissOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setTermPanel(null);
    };
    document.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("keydown", dismissOnEscape);
    };
  }, [termPanel?.pinned]);

  useEffect(() => {
    if (!themeMenuOpen) return;
    const dismiss = (event: PointerEvent) => {
      if ((event.target as HTMLElement).closest(".reader-theme-control")) return;
      setThemeMenuOpen(false);
    };
    const dismissOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setThemeMenuOpen(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("keydown", dismissOnEscape);
    };
  }, [themeMenuOpen]);

  const choosePrompt = (category: PromptTemplateCategory, id: string) => {
    selectPromptTemplate(category, id);
    if (category === "reader") setReaderPromptId(id);
    else if (category === "translation") setTranslationPromptId(id);
    else if (category === "explanation") setExplanationPromptId(id);
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
  const translationCredentialReady = !nativeRuntime || Boolean(translationProvider && providerCredentialQuery.data?.some(
    (summary) => summary.credentialId === translationProvider.credentialId && summary.configured,
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

  const translate = async (block: ReaderBlock, batch?: { groupKey: string; totalItems: number; label: string }): Promise<boolean> => {
    const kind = "kind" in block && block.kind === "word" ? "word" : "passage";
    const selectedRange = block as Partial<SelectionSource>;
    if (kind === "passage" && !selectedRange.sourceBlockText) {
      const chunks = splitTranslationChunks(block.text);
      if (chunks.length > 1) {
        let succeeded = true;
        for (const [index, chunk] of chunks.entries()) {
          const chunkBlock: SelectionSource = {
            ...block,
            id: `${block.id}:translation-chunk:${index + 1}`,
            sourceBlockId: block.id,
            sourceBlockText: block.text,
            text: chunk.text,
            start: chunk.start,
            end: chunk.end,
            left: 0,
            top: 0,
            placement: "below",
            kind: "passage",
          };
          if (!await translate(chunkBlock, batch)) succeeded = false;
        }
        return succeeded;
      }
    }
    if (!translationModel || !translationProvider || !translationCredentialReady) {
      const message = translationModel && translationProvider
        ? `“${translationModel.displayName}”缺少 API Key，请先到“模型与处理”中恢复或重新保存密钥。`
        : "尚未选择可用于翻译的模型，请先完成模型配置。";
      setTranslations((current) => ({ ...current, [block.id]: { status: "error", text: "", kind, error: message } }));
      setContextNotice(message);
      return false;
    }
    if (kind === "passage" && /reason|deepseek|\bo[134]\b/i.test(translationModel.model) && translationModel.maxOutputTokens < 4096) {
      const message = `“${translationModel.displayName}”是推理模型，但最大输出仅 ${translationModel.maxOutputTokens} tokens，容易在输出译文前耗尽预算。请在“模型与处理”选择直接输出模型，或把该模型输出上限提高到至少 4096。`;
      setTranslations((current) => ({ ...current, [block.id]: { status: "error", text: "", kind, error: message } }));
      setContextNotice(message);
      return false;
    }
    const existing = streamHandles.current.get(block.id);
    if (existing) {
      await existing.cancel();
      existing.dispose();
      streamHandles.current.delete(block.id);
    }
    setActiveBlock(block.id);
    setActiveAnalysis(null);
    const requestId = crypto.randomUUID();
    const activityStartedAt = Date.now();
    setTranslations((current) => ({ ...current, [block.id]: { status: "streaming", text: "", kind, requestId, activityPhase: "preparing", startedAt: activityStartedAt, receivedCharacters: 0, reasoningCharacters: 0 } }));
    const slowTimer = setTimeout(() => updateTranslation(block.id, (current) => current.status === "streaming" && !(current.receivedCharacters ?? 0) ? { ...current, slow: true } : current), 90_000);
    translationSlowTimers.current.set(block.id, slowTimer);
    let rawBuffer = "";
    let textBuffer = "";
    let activeHandle: ModelStreamHandle | null = null;
    let finished = false;
    let complete!: (succeeded: boolean) => void;
    const completion = new Promise<boolean>((resolve) => { complete = resolve; });
    const finish = (succeeded: boolean) => {
      if (finished) return;
      finished = true;
      const timer = translationSlowTimers.current.get(block.id);
      if (timer) clearTimeout(timer);
      translationSlowTimers.current.delete(block.id);
      activeHandle?.dispose();
      streamHandles.current.delete(block.id);
      complete(succeeded);
    };
    const failTranslation = (message: string) => {
      updateTranslation(block.id, (current) => ({ ...current, status: "error", activityPhase: "error", error: message, slow: false }));
      failModelActivity(requestId, message);
      setContextNotice(message);
      finish(false);
    };
    const onEvent = (event: ModelStreamEvent) => {
      if (event.kind === "started") {
        updateTranslation(block.id, (current) => ({ ...current, activityPhase: "sending" }));
      } else if (event.kind === "connected") {
        updateTranslation(block.id, (current) => ({ ...current, activityPhase: "connected" }));
      } else if (event.kind === "thinking") {
        updateTranslation(block.id, (current) => ({ ...current, activityPhase: "thinking", reasoningCharacters: (current.reasoningCharacters ?? 0) + (event.reasoningCharacters ?? 0) }));
      } else if (event.kind === "delta" && event.text) {
        if (kind === "word") textBuffer += event.text;
        else rawBuffer += event.text;
        updateTranslation(block.id, (current) => kind === "word"
          ? ({ ...current, status: "streaming", activityPhase: "streaming", receivedCharacters: (current.receivedCharacters ?? 0) + event.text!.length, text: current.text + event.text })
          : ({ ...current, status: "streaming", activityPhase: "streaming", receivedCharacters: (current.receivedCharacters ?? 0) + event.text!.length, raw: (current.raw ?? "") + event.text }));
      } else if (event.kind === "done") {
        if (kind === "word" && !textBuffer.trim()) {
          failTranslation(`模型消耗了 ${event.usage?.outputTokens ?? 0} 个输出 token，但没有返回可用词义。请停止推理模式或改用更快的文本模型。`);
          return;
        }
        if (kind === "passage" && !rawBuffer.trim()) {
          failTranslation(`模型消耗了 ${event.usage?.outputTokens ?? 0} 个输出 token，但没有返回可用译文。请停止推理模式或改用更快的文本模型。`);
          return;
        }
        const parsed = kind === "passage" ? parseStructuredTranslation(block.text, rawBuffer) : undefined;
        if (parsed && !parsed.structured) {
          failTranslation(parsed.error ?? "模型没有返回完整的结构化译文，请重试或更换文本模型。");
          return;
        }
        const completedState: TranslationState = kind === "word"
          ? { status: "unsaved", text: textBuffer, kind, requestId, activityPhase: "saving", startedAt: activityStartedAt, receivedCharacters: textBuffer.length }
          : { status: "unsaved", text: parsed!.translatedText, raw: rawBuffer, segments: parsed!.segments, terms: parsed!.terms, kind, requestId, activityPhase: "saving", startedAt: activityStartedAt, receivedCharacters: rawBuffer.length, reasoningCharacters: 0 };
        markModelActivitySaving(requestId);
        setTranslations((current) => ({ ...current, [block.id]: completedState }));
        void persistTranslation(block, completedState)
          .then((saved) => {
            if (saved) setContextNotice(kind === "word"
              ? "词义已保存到本篇论文。"
              : parsed?.missingSegmentIds.length
                ? `已保存 ${parsed.segments.length} 个句段，另有 ${parsed.missingSegmentIds.length} 个句段未返回；可单独选择失败句重试。`
                : "译文已保存，可随时切换回英文原文。");
            finish(saved);
          });
      } else if (event.kind === "cancelled") {
        updateTranslation(block.id, (current) => ({ ...current, status: "cancelled", activityPhase: "cancelled", slow: false }));
        finish(false);
      } else if (event.kind === "error") {
        const message = event.error ?? "翻译请求失败，请检查模型、Base URL 与密钥。";
        failTranslation(message);
      }
    };
    try {
      const handle = await startModelStream({
        requestId,
        provider: translationProvider,
        model: translationModel,
        temperature: 0,
        reasoningMode: "disabled",
        maxOutputTokens: kind === "word"
          ? Math.min(translationModel.maxOutputTokens, 2048)
          : Math.min(translationModel.maxOutputTokens, Math.max(1536, Math.ceil(block.text.length * 1.5) + (/reason|deepseek|\bo[134]\b/i.test(translationModel.model) ? 3072 : 768))),
        messages: kind === "word" ? buildWordLookupMessages(block.text, paperWordContextFor(block)).map((message, index) => index === 0 ? { ...message, content: `${translationPrompt?.content ?? ""}\n\n${message.content}` } : message) : [
          { role: "system", content: translationPrompt?.content ?? "请将科研文本忠实翻译为简体中文，保留公式、术语、引用和数字，只返回译文。" },
          { role: "user", content: structuredTranslationPrompt(block.text) },
        ],
      }, onEvent, { source: kind === "word" ? "word-lookup" : "translation", label: kind === "word" ? `查询术语：${block.text}` : batch?.label ?? "翻译论文文本", groupKey: kind === "word" ? undefined : batch?.groupKey ?? `translation:${paper.id}`, totalItems: batch?.totalItems, deferCompletion: true });
      activeHandle = handle;
      if (finished) handle.dispose();
      else streamHandles.current.set(block.id, handle);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateTranslation(block.id, (current) => ({ ...current, status: "error", error: message }));
      failModelActivity(requestId, message);
      setContextNotice(message);
      finish(false);
    }
    return completion;
  };

  const cancelTranslation = async (blockId: string) => {
    await streamHandles.current.get(blockId)?.cancel();
  };

  async function persistTranslation(block: ReaderBlock, state: TranslationState): Promise<boolean> {
    if (!paper || !translationModel || !state.text.trim()) {
      const message = "模型没有返回可保存的译文。";
      updateTranslation(block.id, (current) => ({ ...current, status: "error", activityPhase: "error", error: message }));
      if (state.requestId) failModelActivity(state.requestId, message);
      return false;
    }
    const selectedRange = block as Partial<SelectionSource>;
    const sourceText = selectedRange.sourceBlockText ?? block.text;
    const sourceStart = selectedRange.start ?? 0;
    const sourceEnd = selectedRange.end ?? sourceText.length;
    const shift = selectedRange.sourceBlockText ? sourceStart : 0;
    const segments = (state.segments ?? []).map((segment) => ({
      ...segment,
      sourceStart: segment.sourceStart + shift,
      sourceEnd: segment.sourceEnd + shift,
      sourceText: sourceText.slice(segment.sourceStart + shift, segment.sourceEnd + shift),
    }));
    const terms = (state.terms ?? []).map((term) => ({
      ...term,
      sourceStart: term.sourceStart === undefined ? undefined : term.sourceStart + shift,
      sourceEnd: term.sourceEnd === undefined ? undefined : term.sourceEnd + shift,
    }));
    try {
      const record = await saveTranslation(root, {
        paperId: paper.id,
        sectionId: block.sectionId,
        blockId: selectedRange.sourceBlockId ?? block.id,
        sourceText,
        translatedText: state.text,
        sourceStart,
        sourceEnd,
        segments,
        terms,
        targetLanguage: "zh-CN",
        modelId: translationModel.id,
        promptVersion: `${state.kind === "word" ? WORD_LOOKUP_PROMPT_VERSION : TRANSLATION_PROMPT_VERSION}:${translationPrompt?.id ?? "default"}`,
      });
      setTranslations((current) => ({ ...current, [block.id]: { status: "saved", text: record.translatedText, segments: record.segments, terms: record.terms, record } }));
      if (state.kind !== "word") {
        setActiveTranslationKeys((current) => {
          const next = new Set(current);
          record.segments.forEach((segment) => next.add(readerTranslationKey(record.id, segment.id)));
          return next;
        });
      }
      await translationQuery.refetch();
      await annotationQuery.refetch();
      if (state.requestId) completeModelActivity(state.requestId);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateTranslation(block.id, (current) => ({ ...current, status: "error", activityPhase: "error", error: message }));
      if (state.requestId) failModelActivity(state.requestId, message);
      return false;
    }
  }

  const translateCurrentSection = async () => {
    const section = sections.find((candidate) => candidate.id === activeSection) ?? sections[0];
    if (!section || translationBatchBusy) return;
    if (!translationCredentialReady) {
      setContextNotice("当前翻译模型缺少密钥，请先在“模型与处理”中恢复或重新保存 API Key。");
      return;
    }
    setTranslationBatchBusy(true);
    try {
      const pendingBlocks = section.blocks.filter((block) => block.text.trim() && !(projectedTranslationsByBlock.get(block.id)?.length));
      const batch = { groupKey: `translation-batch:${paper.id}:${section.id}:${Date.now()}`, totalItems: pendingBlocks.length, label: `翻译章节：${section.title}` };
      let succeeded = 0;
      let failed = 0;
      for (const block of pendingBlocks) {
        if (await translate(block, batch)) succeeded += 1;
        else failed += 1;
      }
      setActiveTranslationKeys((current) => {
        const next = new Set(current);
        (translationQuery.data ?? []).filter((record) => section.blocks.some((block) => block.id === record.blockId) && !record.promptVersion.startsWith(WORD_LOOKUP_PROMPT_VERSION)).forEach((record) => record.segments.forEach((segment) => next.add(readerTranslationKey(record.id, segment.id))));
        return next;
      });
      const skipped = Math.max(0, section.blocks.length - pendingBlocks.length);
      setContextNotice(`“${section.title}”翻译完成：成功 ${succeeded}，失败 ${failed}，跳过 ${skipped}。`);
    } finally {
      setTranslationBatchBusy(false);
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
    const sourceBlockId = (block as Partial<SelectionSource>).sourceBlockId ?? block.id;
    const index = blocks.findIndex((candidate) => candidate.id === sourceBlockId);
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
    const requestId = crypto.randomUUID();
    let text = "";
    let terminal = false;
    setAnalysisStates((current) => ({ ...current, [key]: {
      status: "streaming",
      text: "",
      adjacentContext,
      usage: { inputTokens: 0, outputTokens: 0, durationMs: 0 },
      requestId,
      activityPhase: "preparing",
    } }));
    const onEvent = (event: ModelStreamEvent) => {
      if (event.kind === "started") {
        updateAnalysis(key, (current) => ({ ...current, activityPhase: "sending" }));
      } else if (event.kind === "connected") {
        updateAnalysis(key, (current) => ({ ...current, activityPhase: "connected" }));
      } else if (event.kind === "delta" && event.text) {
        text += event.text;
        updateAnalysis(key, (current) => ({ ...current, status: "streaming", activityPhase: "streaming", text }));
      } else if (event.kind === "done") {
        terminal = true;
        markModelActivitySaving(requestId);
        const completed: AnalysisState = { status: "unsaved", text, adjacentContext, requestId, activityPhase: "saving", usage: {
          inputTokens: event.usage?.inputTokens ?? 0,
          outputTokens: event.usage?.outputTokens ?? 0,
          durationMs: Math.round(performance.now() - started),
        } };
        updateAnalysis(key, () => completed);
        void persistAnalysis(block, type, completed);
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
        requestId,
        provider: selectedProvider,
        model: selectedModel,
        temperature: 0.1,
        messages: [
          { role: "system", content: `${explanationPrompt?.content ?? "请用中文严谨解释给定科研内容，并引用来源锚点。"}\n\n${type === "formula" ? "本次重点解释公式：定义每个符号、量纲、运算、作用、假设和歧义，保留 LaTeX。" : type === "grammar" ? "本次进行面向中文母语者的英文语法精读。请依次给出：句子主干、从句与修饰关系、关键句型、论文专业搭配、容易误读之处、自然中文理解。不要把普通词汇包装成专业术语。" : "本次重点解释论断或定理：说明命题、假设、推理概要、影响和局限。"}` },
          { role: "user", content: `来源锚点：paper=${paper.id}, section=${block.sectionId}, block=${(block as Partial<SelectionSource>).sourceBlockId ?? block.id}, page=${block.page ?? "未知"}\n\n目标原文：\n${block.text}\n\n相邻结构化上下文：\n${adjacentContext}` },
        ],
      }, onEvent, { source: type === "grammar" ? "grammar" : "analysis", label: type === "formula" ? "解释论文公式" : type === "grammar" ? "语法精读" : "解释论文论述", groupKey: `analysis:${paper.id}`, deferCompletion: true });
      if (terminal) handle.dispose();
      else streamHandles.current.set(handleKey, handle);
    } catch (error) {
      updateAnalysis(key, (current) => ({ ...current, status: "error", error: error instanceof Error ? error.message : String(error) }));
    }
  };

  const persistAnalysis = async (block: ReaderBlock, type: ReaderAnalysisType, state: AnalysisState) => {
    if (!selectedModel || !state.text.trim()) return;
    const key = analysisKey(block.id, type);
    const selectedRange = block as Partial<SelectionSource>;
    try {
      const record = await saveReaderAnalysis(root, {
        paperId: paper.id,
        sectionId: block.sectionId,
        blockId: selectedRange.sourceBlockId ?? block.id,
        analysisType: type,
        sourceText: block.text,
        sourceStart: selectedRange.start ?? 0,
        sourceEnd: selectedRange.end ?? block.text.length,
        selectedText: block.text,
        adjacentContext: state.adjacentContext,
        resultText: state.text,
        modelId: selectedModel.id,
        promptVersion: `${ANALYSIS_PROMPT_VERSION}:${explanationPrompt?.id ?? "default"}`,
        inputTokens: state.usage.inputTokens,
        outputTokens: state.usage.outputTokens,
        durationMs: state.usage.durationMs,
      });
      setAnalysisStates((current) => ({ ...current, [key]: { ...state, status: "saved", text: record.resultText, record } }));
      if (state.requestId) completeModelActivity(state.requestId, { inputTokens: state.usage.inputTokens, outputTokens: state.usage.outputTokens });
      await analysisQuery.refetch();
      const refreshedAnnotations = await annotationQuery.refetch();
      if (type === "grammar") {
        const annotation = refreshedAnnotations.data?.find((candidate) => candidate.targetType === "analysis" && candidate.relatedId === record.id);
        if (annotation) setAnnotationInspector({ kind: "chat", relatedId: record.id, annotationIds: [annotation.id], left: Math.max(12, Math.min(window.innerWidth - 432, selectedRange.left ?? 24)), top: Math.max(12, Math.min(window.innerHeight - 180, selectedRange.top ?? 80)) });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateAnalysis(key, (current) => ({ ...current, status: "error", activityPhase: "error", error: message }));
      if (state.requestId) failModelActivity(state.requestId, message);
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
    const requestId = crypto.randomUUID();
    const usage = await new Promise<{ inputTokens?: number; outputTokens?: number }>((resolve, reject) => {
      let handle: ModelStreamHandle | undefined;
      const onEvent = (event: ModelStreamEvent) => {
        if (event.kind === "delta" && event.text) output += event.text;
        if (event.kind === "done") { handle?.dispose(); resolve(event.usage ?? {}); }
        else if (event.kind === "cancelled") { handle?.dispose(); reject(new Error("上下文压缩已取消。")); }
        else if (event.kind === "error") { handle?.dispose(); reject(new Error(event.error ?? "上下文压缩失败。")); }
      };
      void startModelStream({ requestId, provider, model, temperature: 0.1, messages: contextCompressionMessages(source) }, onEvent, { source: "context-compression", label: "压缩论文上下文", groupKey: `context:${paper.id}` })
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

  const sendChat = async (retryTurn?: ReaderChatTurn, editedMessage?: string) => {
    if (chatStatus === "streaming") return;
    const userMessage = editedMessage?.trim() || retryTurn?.userMessage || chatInput.trim();
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
    const priorMessages = (chatQuery.data?.turns ?? []).filter((turn) => turn.id !== retryTurn?.id).slice(-6).flatMap((turn) => [
      { role: "user" as const, content: turn.userMessage },
      ...(turn.response?.assistantText ? [{ role: "assistant" as const, content: turn.response.assistantText }] : []),
    ]);
    const persistTerminal = async (status: "completed" | "cancelled" | "failed", event: ModelStreamEvent) => {
      if (terminal) return;
      terminal = true;
      const finalStatus = status === "completed" && !responseText.trim() ? "failed" : status;
      const finalError = finalStatus === "failed" ? event.error ?? "The model returned an empty response." : undefined;
      try {
        const turnPayload = {
          paperId: paper.id,
          userMessage,
          assistantText: responseText,
          contextSnapshot: editedMessage !== undefined ? assembled.snapshot : retryTurn?.contextSnapshot ?? assembled.snapshot,
          modelId: selectedModel.id,
          promptVersion: `${CHAT_PROMPT_VERSION}:${readerPrompt?.id ?? "default"}`,
          status: finalStatus,
          inputTokens: event.usage?.inputTokens,
          outputTokens: event.usage?.outputTokens,
          durationMs: Math.round(performance.now() - started),
          error: finalError,
        };
        const savedTurn = retryTurn && editedMessage !== undefined
          ? await updateReaderChatTurn(root, { ...turnPayload, turnId: retryTurn.id })
          : await saveReaderChatTurn(root, { ...turnPayload, turnId: retryTurn?.id });
        if (!retryTurn && pendingChatSelection) {
          await saveReaderAnnotation(root, {
            paperId: paper.id,
            sectionId: pendingChatSelection.sectionId,
            blockId: pendingChatSelection.sourceBlockId,
            sourceStart: pendingChatSelection.start,
            sourceEnd: pendingChatSelection.end,
            annotationType: "chat",
            targetType: "chat_turn",
            relatedId: savedTurn.id,
            selectedText: pendingChatSelection.text,
          });
          setPendingChatSelection(null);
          await annotationQuery.refetch();
        }
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
      }, onEvent, { source: "reader-chat", label: "论文阅读助手回答", groupKey: `chat:${paper.id}` });
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
  const captureSelection = (block: ReaderBlock, event: ReactMouseEvent<HTMLElement>) => {
    const selected = window.getSelection();
    const range = selected?.rangeCount ? selected.getRangeAt(0) : undefined;
    const mapped = range ? sourceRangeFromDomRange(range, block.text) : undefined;
    if (!mapped?.text) return;
    const rect = range?.getBoundingClientRect();
    const center = rect && rect.width > 0 ? rect.left + rect.width / 2 : event.clientX;
    const placeAbove = (rect?.top ?? event.clientY) > 64;
    const backward = Boolean(selected && selected.anchorNode && selected.focusNode && (() => {
      const probe = document.createRange();
      try {
        probe.setStart(selected.anchorNode!, selected.anchorOffset);
        probe.collapse(true);
        return probe.compareBoundaryPoints(Range.START_TO_START, range!) > 0;
      } catch {
        return false;
      }
    })());
    setSelection({
      ...block,
      sourceBlockId: block.id,
      sourceBlockText: block.text,
      id: `${block.id}:selection:${mapped.start}:${mapped.end}`,
      text: mapped.text.slice(0, 2000),
      start: mapped.start,
      end: mapped.end,
      left: Math.max(120, Math.min(window.innerWidth - 120, center)),
      top: placeAbove ? (rect?.top ?? event.clientY) - 8 : (rect?.bottom ?? event.clientY) + 8,
      placement: placeAbove ? "above" : "below",
      kind: isSingleEnglishWord(mapped.text) ? "word" : "passage",
      backward,
    });
  };

  const openSentenceMenu = (block: ReaderBlock, event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("button, a, code, pre, img, .katex, .reader-annotation-rail")) return;
    const caretApi = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
    const caret = caretApi.caretRangeFromPoint?.(event.clientX, event.clientY);
    if (!caret) return;
    const offset = sourceOffsetFromDomPoint(caret.startContainer, caret.startOffset);
    const sentence = offset === undefined ? undefined : sentenceRangeAtOffset(block.text, offset);
    if (!sentence) return;
    event.preventDefault();
    setSelection(null);
    setSentenceMenu({
      left: Math.max(10, Math.min(window.innerWidth - 230, event.clientX)),
      top: Math.max(10, Math.min(window.innerHeight - 210, event.clientY)),
      source: {
        ...block,
        sourceBlockId: block.id,
        sourceBlockText: block.text,
        id: `${block.id}:sentence:${sentence.start}:${sentence.end}`,
        text: sentence.text,
        start: sentence.start,
        end: sentence.end,
        left: event.clientX,
        top: event.clientY,
        placement: "below",
        kind: "passage",
      },
    });
  };

  const askAboutSelection = async (selected: SelectionSource) => {
    await addContext(selected.sectionId, `selection:${selected.id}`, selected.text);
    setChatInput(`请结合论文全文解释这段内容：\n\n“${selected.text}”\n\n`);
    setPendingChatSelection(selected);
    setAgentOpen(true);
    setAgentCollapsed(false);
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
    if (nextMode !== "integrated") {
      setSelection(null);
      setSentenceMenu(null);
    }
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

  const openAnnotationInspector = (kind: "translation" | "chat", relatedId: string | undefined, annotationIds: string[], rect: DOMRect) => {
    setEditingTurn(null);
    setAnnotationInspector({
      kind,
      relatedId,
      annotationIds,
      left: Math.max(12, Math.min(window.innerWidth - 432, rect.left)),
      top: Math.min(window.innerHeight - 120, rect.bottom + 8),
    });
  };
  const toggleInlineTranslation = (key: string) => {
    setActiveTranslationKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setTermPanel(null);
  };
  const openTermPanel = (term: TranslationTerm, sentence: string, language: "source" | "translated", rect: DOMRect, pinned: boolean) => {
    if (termPanelCloseTimer.current) clearTimeout(termPanelCloseTimer.current);
    const panelWidth = Math.min(420, window.innerWidth - 24);
    const left = Math.max(12, Math.min(window.innerWidth - panelWidth - 12, rect.left));
    const below = rect.bottom + 10;
    const top = below + 300 <= window.innerHeight ? below : Math.max(12, rect.top - 310);
    setTermPanel((current) => pinned && current?.pinned && current.term.text === term.text && current.term.translation === term.translation
      ? null
      : { term, sentence, language, left, top, pinned });
  };
  const scheduleTermPanelClose = () => {
    if (termPanel?.pinned) return;
    if (termPanelCloseTimer.current) clearTimeout(termPanelCloseTimer.current);
    termPanelCloseTimer.current = setTimeout(() => setTermPanel((current) => current?.pinned ? current : null), 180);
  };
  const inspectorTranslation = annotationInspector?.kind === "translation"
    ? translationQuery.data?.find((record) => record.id === annotationInspector.relatedId)
    : undefined;
  const inspectorTranslationSource = inspectorTranslation
    ? (inspectorTranslation.sourceText.length >= inspectorTranslation.sourceEnd
      ? inspectorTranslation.sourceText.slice(inspectorTranslation.sourceStart, inspectorTranslation.sourceEnd)
      : inspectorTranslation.sourceText)
    : "";
  const inspectorTranslationSection = inspectorTranslation
    ? sections.find((section) => section.id === inspectorTranslation.sectionId)
    : undefined;
  const inspectorTranslationProjections = inspectorTranslation && inspectorTranslationSection
    ? projectTranslationSegmentsAcrossBlocks(inspectorTranslation.sourceText, inspectorTranslationSection.blocks, inspectorTranslation.segments)
    : [];
  const inspectorTranslationBlock = inspectorTranslationSection?.blocks.find((block) => (
    inspectorTranslationProjections.some((projection) => projection.status !== "stale" && projection.blockId === block.id)
  )) ?? inspectorTranslationSection?.blocks.find((block) => block.id === inspectorTranslation?.blockId);
  const inspectorTranslationMatched = inspectorTranslationProjections.filter((projection) => projection.status !== "stale").length;
  const inspectorTranslationStale = inspectorTranslation ? inspectorTranslationMatched < inspectorTranslation.segments.length : false;
  const inspectorDraftBlockId = annotationInspector?.relatedId?.startsWith("draft:") ? annotationInspector.relatedId.slice(6) : undefined;
  const inspectorDraftTranslation = inspectorDraftBlockId ? translations[inspectorDraftBlockId] : undefined;
  const inspectorDraftBlock = inspectorDraftBlockId ? sections.flatMap((section) => section.blocks).find((block) => block.id === inspectorDraftBlockId) : undefined;
  const inspectorAnnotation = annotationInspector?.kind === "chat"
    ? annotationQuery.data?.find((annotation) => annotationInspector.annotationIds.includes(annotation.id))
    : undefined;
  const inspectorAnalysis = inspectorAnnotation?.targetType === "analysis"
    ? analysisQuery.data?.find((record) => record.id === inspectorAnnotation.relatedId)
    : undefined;
  const inspectorTurn = annotationInspector?.kind === "chat" && (!inspectorAnnotation || inspectorAnnotation.targetType === "chat_turn")
    ? chatQuery.data?.turns.find((turn) => turn.id === (inspectorAnnotation?.relatedId ?? annotationInspector.relatedId))
    : undefined;
  const inspectorContextBlockId = inspectorAnalysis
    ? `ai-analysis:${inspectorAnalysis.analysisType}:${inspectorAnalysis.blockId}`
    : inspectorTurn ? `chat:${inspectorTurn.id}` : undefined;
  const inspectorContextItem = inspectorContextBlockId
    ? contextDraftQuery.data?.items.find((item) => item.paperId === paper.id && item.blockId === inspectorContextBlockId)
    : undefined;
  const removeInspectorMarkers = async () => {
    if (!annotationInspector) return;
    await Promise.all(annotationInspector.annotationIds.map((annotationId) => deleteReaderAnnotation(root, paper.id, annotationId)));
    await annotationQuery.refetch();
    setAnnotationInspector(null);
  };
  const deleteInspectorContent = async () => {
    if (inspectorTranslation) {
      await deleteTranslation(root, paper.id, inspectorTranslation.id);
      await Promise.all([translationQuery.refetch(), annotationQuery.refetch()]);
    } else if (inspectorAnalysis) {
      await deleteReaderAnalysis(root, paper.id, inspectorAnalysis.id);
      await Promise.all([analysisQuery.refetch(), annotationQuery.refetch()]);
    } else if (inspectorTurn) {
      await deleteReaderChatTurn(root, paper.id, inspectorTurn.id);
      await Promise.all([chatQuery.refetch(), annotationQuery.refetch()]);
    }
    setAnnotationInspector(null);
  };
  const toggleInspectorContext = async () => {
    if (inspectorContextItem) {
      await deleteContextItem(inspectorContextItem.id);
      return;
    }
    if (inspectorAnalysis) {
      await addContext(inspectorAnalysis.sectionId, `ai-analysis:${inspectorAnalysis.analysisType}:${inspectorAnalysis.blockId}`, `用户分析对象：\n${inspectorAnalysis.sourceText}\n\nAI 解释：\n${inspectorAnalysis.resultText}`);
    } else if (inspectorTurn?.response?.assistantText) {
      await addContext("reader-chat", `chat:${inspectorTurn.id}`, `用户问题：\n${inspectorTurn.userMessage}\n\nAI 回答：\n${inspectorTurn.response.assistantText}`);
    }
  };

  const sourcePdfUrl = assetUrl(paper.sourcePath);
  const pagedPdfUrl = sourcePdfUrl ? `${sourcePdfUrl}#page=${pdfPage}&view=FitH` : "";
  const renderedOutlineWidth = outlineCollapsed ? COLLAPSED_OUTLINE_WIDTH : outlineWidth;
  const renderedAgentWidth = agentCollapsed ? COLLAPSED_AGENT_WIDTH : agentWidth;
  const selectionTranslation = selection ? translations[selection.id] ?? persistedTranslations[selection.id] : undefined;
  const hasPassageTranslations = (translationQuery.data ?? []).some((record) => !record.promptVersion.startsWith(WORD_LOOKUP_PROMPT_VERSION))
    || Object.values(translations).some((state) => state.kind !== "word" && Boolean(state.text));
  const themeColors = readerTheme === "custom"
    ? customReaderPalette(readerBackgroundColor, readerTextColor)
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
    "--reader-body-font-size": `${10 * (fontSize === "large" ? 1.3 : fontSize === "medium" ? 1.15 : 1) * (readerZoom / 100)}px`,
    "--reader-section-font-size": `${12 * (fontSize === "large" ? 1.3 : fontSize === "medium" ? 1.15 : 1) * (readerZoom / 100)}px`,
    "--reader-title-font-size": `${22 * (fontSize === "large" ? 1.3 : fontSize === "medium" ? 1.15 : 1) * (readerZoom / 100)}px`,
    "--reader-background": themeColors.background,
    "--reader-paper": themeColors.paper,
    "--reader-surface": themeColors.surface,
    "--reader-text": themeColors.text,
    "--reader-muted": themeColors.muted,
    "--reader-border": themeColors.border,
    "--reader-control": themeColors.control,
  } as CSSProperties;

  return <div className={`reader-workspace ${readerFocusMode ? "focus-mode" : ""}`} style={readerPanelStyle}>
    {readerFocusMode && <button className="reader-focus-exit" onClick={() => void toggleFocusMode(false)} title="退出纯享模式（Esc）"><Minimize2 size={14} /> 退出纯享</button>}
    {selection && !selection.hidden && <div ref={selectionToolbar} className={`selection-popover ${selection.placement} ${selectionTranslation ? "with-result" : ""}`} style={{ left: selection.left, top: selection.top }} role="dialog" aria-label={selection.kind === "word" ? "论文语境查词" : "选中文本操作"} onPointerDown={(event) => event.preventDefault()}>
      <div className="selection-popover-actions"><button title={selection.kind === "word" ? "结合全文语境查词" : "翻译选中文本"} onClick={() => void translate(selection)}><Languages size={14} /> {selection.kind === "word" ? "查词" : "翻译"}</button><button title="在本篇论文的统一对话中提问" onClick={() => void askAboutSelection(selection)}><MessageSquareText size={14} /> 提问</button><button title="解释选中文本" onClick={() => void explain("theorem", selection)}><Sparkles size={14} /> 解释</button>{selection.kind === "word" && <button title="朗读单词" onClick={() => speakWord(selection.text)}><Volume2 size={14} /> 读音</button>}<button className="icon-button" title="关闭" onClick={() => setSelection(null)}><X size={14} /></button></div>
      {selectionTranslation && <TranslationPanel block={selection} state={selectionTranslation} compact onSave={() => void persistTranslation(selection, selectionTranslation)} onRetry={() => void translate(selection)} onCancel={() => void cancelTranslation(selection.id)} onSpeak={selection.kind === "word" ? () => speakWord(selection.text) : undefined} onAddContext={() => void addContext(selection.sectionId, `ai-translation:${selection.id}`, `原文：\n${selection.text}\n\nAI ${selection.kind === "word" ? "论文语境词义" : "翻译"}：\n${selectionTranslation.text}`)} inContext={Boolean(contextDraftQuery.data?.items.some((item) => item.paperId === paper.id && item.blockId === `ai-translation:${selection.id}`))} />}
    </div>}
    {termPanel && createPortal(<div className={`reader-term-panel ${termPanel.pinned ? "pinned" : "preview"}`} style={{ ...readerPanelStyle, left: termPanel.left, top: termPanel.top }} role="dialog" aria-label="论文术语释义" onPointerEnter={() => { if (termPanelCloseTimer.current) clearTimeout(termPanelCloseTimer.current); }} onPointerLeave={scheduleTermPanelClose}>
      <header><div><span className={`term-kind ${termPanel.term.kind}`}>{termPanel.term.kind === "phrase" ? "技术概念" : "专业术语"}</span><strong>{termPanel.language === "source" ? termPanel.term.text : termPanel.term.translation}</strong></div><button type="button" className="icon-button" title="关闭" onClick={() => setTermPanel(null)}><X size={14} /></button></header>
      <div className="reader-term-original">{termPanel.language === "source" ? termPanel.term.translation : termPanel.term.text}</div>
      <dl>{termPanel.term.domain && <><dt>所属领域</dt><dd>{termPanel.term.domain}</dd></>}{termPanel.term.literalMeaning && <><dt>直译</dt><dd>{termPanel.term.literalMeaning}</dd></>}<dt>论文语境</dt><dd>{termPanel.term.contextMeaning || termPanel.term.explanation || termPanel.term.translation}</dd>{termPanel.term.selectionReason && <><dt>为何重要</dt><dd>{termPanel.term.selectionReason}</dd></>}<dt>所在句子</dt><dd className="term-source-sentence">{termPanel.sentence}</dd></dl>
      {!termPanel.pinned && <footer>点击术语可固定此卡片</footer>}
    </div>, document.body)}
    {sentenceMenu && createPortal(<div className="reader-sentence-menu" style={{ ...readerPanelStyle, left: sentenceMenu.left, top: sentenceMenu.top }} role="menu" aria-label="句子精读工具">
      <header><strong>句子精读</strong><small title={sentenceMenu.source.text}>{sentenceMenu.source.text}</small></header>
      <button role="menuitem" onClick={() => { const source = sentenceMenu.source; setSentenceMenu(null); void explain("grammar", source); }}><BookOpenText size={14} /><span><b>语法精读</b><small>主干、从句、句型与易错点</small></span></button>
      <button role="menuitem" onClick={() => { const source = sentenceMenu.source; setSentenceMenu(null); setSelection(source); void translate(source); }}><Languages size={14} /><span><b>翻译本句</b><small>结合论文语境生成中文</small></span></button>
      <button role="menuitem" onClick={() => { const source = sentenceMenu.source; setSentenceMenu(null); void addContext(source.sectionId, `selection:${source.id}`, source.text); }}><Layers3 size={14} /><span><b>加入论文上下文</b><small>供后续多轮问答使用</small></span></button>
      <button role="menuitem" onClick={() => { void navigator.clipboard.writeText(sentenceMenu.source.text); setSentenceMenu(null); setContextNotice("句子原文已复制。"); }}><FileText size={14} /><span><b>复制原文</b><small>保持英文内容不变</small></span></button>
    </div>, document.body)}
    {annotationInspector && <div className="reader-annotation-inspector" style={{ left: annotationInspector.left, top: annotationInspector.top }} role="dialog" aria-label={annotationInspector.kind === "translation" ? "译文详情" : "对话详情"}>
      <header><div><span className={`annotation-kind ${annotationInspector.kind}`}>{annotationInspector.kind === "translation" ? "译文" : inspectorAnalysis ? (inspectorAnalysis.analysisType === "formula" ? "公式解释" : inspectorAnalysis.analysisType === "grammar" ? "语法精读" : "论述解释") : "论文对话"}</span>{(inspectorTranslation || inspectorAnalysis || inspectorTurn) && <small>已保存</small>}{inspectorDraftTranslation && <small>待保存</small>}</div><button className="icon-button" title="关闭" onClick={() => setAnnotationInspector(null)}><X size={14} /></button></header>
      {inspectorTranslation && <div className="annotation-inspector-content translation-inspector-content"><section><h4>英文原文</h4><p className="annotation-source">{inspectorTranslationSource}</p></section><section><h4>中文译文</h4><div className="annotation-answer"><MarkdownBlock value={inspectorTranslation.translatedText} /></div></section><div className={`translation-anchor-status ${inspectorTranslationStale ? "warning" : "ready"}`}>{inspectorTranslationStale ? <TriangleAlert size={13} /> : <Check size={13} />}<span>{inspectorTranslationStale ? `已匹配 ${inspectorTranslationMatched}/${inspectorTranslation.segments.length} 句，原文结构已变化。` : `已匹配 ${inspectorTranslationMatched}/${inspectorTranslation.segments.length} 句。`}</span></div>{inspectorTranslation.terms.length > 0 && <div className="annotation-terms">{inspectorTranslation.terms.map((term, index) => <div key={`${term.text}:${index}`}><b>{term.text}</b><span>{term.translation}</span><small>{term.contextMeaning || term.explanation}</small></div>)}</div>}</div>}
      {inspectorDraftTranslation && <div className="annotation-inspector-content"><p className="annotation-source">{inspectorDraftBlock?.text}</p><div className="annotation-answer"><MarkdownBlock value={inspectorDraftTranslation.text} /></div></div>}
      {inspectorAnalysis && <div className="annotation-inspector-content"><p className="annotation-source">{inspectorAnalysis.sourceText}</p><div className="annotation-answer"><MarkdownBlock value={inspectorAnalysis.resultText} /></div><small>{inspectorAnalysis.usage.outputTokens} tokens · {(inspectorAnalysis.usage.durationMs / 1000).toFixed(1)} 秒 · 修订 {inspectorAnalysis.revision}</small></div>}
      {inspectorTurn && <div className="annotation-inspector-content">{editingTurn?.turnId === inspectorTurn.id ? <label className="annotation-question-editor"><span>修改问题</span><textarea value={editingTurn.question} onChange={(event) => setEditingTurn({ ...editingTurn, question: event.target.value })} /></label> : <p className="annotation-source">{inspectorTurn.userMessage}</p>}<div className="annotation-answer"><MarkdownBlock value={inspectorTurn.response?.assistantText || "该问答尚未生成有效回答。"} /></div><small>问题修订 {Math.max(1, inspectorTurn.revisions.length)} · 回答修订 {inspectorTurn.response?.revision ?? 0}</small></div>}
      {!inspectorTranslation && !inspectorDraftTranslation && !inspectorAnalysis && !inspectorTurn && <div className="annotation-inspector-empty"><p>这是旧版正文标记，未能精确关联到单条记录。</p><button onClick={() => { setAgentOpen(true); setAgentCollapsed(false); setAnnotationInspector(null); }}>打开论文对话</button></div>}
      <footer>
        {inspectorTurn && (editingTurn?.turnId === inspectorTurn.id ? <><button className="primary-button compact" disabled={!editingTurn.question.trim() || chatStatus === "streaming"} onClick={() => { void sendChat(inspectorTurn, editingTurn.question); setEditingTurn(null); }}>保存并重新生成</button><button onClick={() => setEditingTurn(null)}>取消</button></> : <button onClick={() => setEditingTurn({ turnId: inspectorTurn.id, question: inspectorTurn.userMessage })}>编辑问题</button>)}
        {inspectorDraftTranslation && inspectorDraftBlock && <button className="primary-button compact" onClick={() => { void persistTranslation(inspectorDraftBlock, inspectorDraftTranslation); setAnnotationInspector(null); }}><Check size={11} /> 保存译文</button>}
        {inspectorTranslationStale && inspectorTranslationBlock && <button onClick={() => { setAnnotationInspector(null); void translate(inspectorTranslationBlock); }}><RefreshCw size={11} /> 重新翻译</button>}
        {inspectorAnalysis && <button onClick={() => { const block = sections.flatMap((section) => section.blocks).find((candidate) => candidate.id === inspectorAnalysis.blockId); if (block) { const target = inspectorAnalysis.analysisType === "grammar" ? { ...block, id: `${block.id}:sentence:${inspectorAnalysis.id}`, sourceBlockId: block.id, sourceBlockText: block.text, text: inspectorAnalysis.sourceText, start: inspectorAnnotation?.sourceStart ?? 0, end: inspectorAnnotation?.sourceEnd ?? inspectorAnalysis.sourceText.length, left: annotationInspector.left, top: annotationInspector.top, placement: "below" as const, kind: "passage" as const } : block; void explain(inspectorAnalysis.analysisType, target); } setAnnotationInspector(null); }}><RefreshCw size={11} /> 重新生成</button>}
        {(inspectorAnalysis || inspectorTurn) && <button onClick={() => { setChatInput(inspectorAnalysis ? `继续追问这段解释：\n\n${inspectorAnalysis.sourceText}\n\n` : `继续追问：${inspectorTurn?.userMessage}\n\n`); setAgentOpen(true); setAgentCollapsed(false); setAnnotationInspector(null); }}><MessageSquareText size={11} /> 继续追问</button>}
        {(inspectorAnalysis || inspectorTurn?.response?.assistantText) && <button className={inspectorContextItem ? "active" : ""} onClick={() => void toggleInspectorContext()}><Layers3 size={11} /> {inspectorContextItem ? "移出上下文" : "加入上下文"}</button>}
        {annotationInspector.annotationIds.length > 0 && <button onClick={() => void removeInspectorMarkers()}>移除正文标记</button>}
        {(inspectorTranslation || inspectorAnalysis || inspectorTurn) && <button className="danger-button" onClick={() => { if (window.confirm("删除这条内容及其正文标记？")) void deleteInspectorContent(); }}><Trash2 size={11} /> 删除</button>}
      </footer>
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
        <div className="reader-theme-control"><button className={themeMenuOpen ? "active reader-theme-trigger" : "reader-theme-trigger"} title={`当前阅读配色：${themeColors.label}`} aria-expanded={themeMenuOpen} onClick={() => setThemeMenuOpen((value) => !value)}><Palette size={13} /><span>阅读配色：{themeColors.label}</span></button>{themeMenuOpen && <div className="reader-theme-menu">
          <header><strong>阅读配色</strong><small>仅调整阅读区域，不影响应用其他页面</small></header><div className="reader-theme-presets">{Object.entries(READER_THEME_COLORS).map(([id, colors]) => <button key={id} className={readerTheme === id ? "active" : ""} aria-current={readerTheme === id ? "true" : undefined} onClick={() => { setReaderTheme(id as keyof typeof READER_THEME_COLORS); setThemeMenuOpen(false); }}><i style={{ background: colors.paper, borderColor: colors.border }}><b style={{ background: colors.text }} /><em style={{ background: colors.muted }} /></i><span><strong>{colors.label}</strong><small>{colors.description}</small></span>{readerTheme === id && <Check size={14} />}</button>)}</div>
          <div className="reader-theme-custom"><strong>自定义颜色</strong><label><span>背景</span><input type="color" value={readerBackgroundColor} onChange={(event) => updateCustomReaderColor("background", event.target.value)} /></label><label><span>文字</span><input type="color" value={readerTextColor} onChange={(event) => updateCustomReaderColor("text", event.target.value)} /></label></div>
        </div>}</div>
        <button className={`reader-annotations-toggle ${readerAnnotationsVisible ? "active" : ""}`} title={readerAnnotationsVisible ? "隐藏译文、问答和术语标注，显示清爽原文" : "显示译文、问答和术语标注"} onClick={() => { setReaderAnnotationsVisible(!readerAnnotationsVisible); setAnnotationInspector(null); setTermPanel(null); }}>{readerAnnotationsVisible ? <EyeOff size={13} /> : <Eye size={13} />}{readerAnnotationsVisible ? "隐藏标注" : "显示标注"}</button>
      </div>}
      <button className="reader-focus-button" onClick={() => void toggleFocusMode(true)} title="只保留目录、Markdown 正文和论文阅读助手"><Maximize2 size={13} /> 纯享阅读</button>
      <button><Search size={13} /> 查找</button>
      <div className="reader-prompt-control"><button className={promptPickerOpen ? "active" : ""} onClick={() => setPromptPickerOpen((value) => !value)}><BookOpenText size={13} /> AI 模板</button>{promptPickerOpen && <div className="reader-prompt-picker">
        {(["translation", "explanation"] as PromptTemplateCategory[]).map((category) => {
          const label = category === "translation" ? "翻译" : "解释";
          const selected = category === "translation" ? translationPrompt : explanationPrompt;
          return <label key={category}><span>{label}</span><select value={selected?.id ?? ""} onChange={(event) => choosePrompt(category, event.target.value)}>{promptTemplates.filter((template) => template.category === category).map((template) => <option value={template.id} key={template.id}>{template.name}</option>)}</select></label>;
        })}
        <button className="reader-prompt-manage" onClick={() => setView("agents")}>管理提示词</button>
      </div>}</div>
      <button className={fullText ? "active" : ""} disabled={contextBusy === "paper"} onClick={() => void togglePaperContext()}><Layers3 size={13} /> {fullText ? `MD 上下文 · ${contextPercent}%` : "加入 MD 原文"}</button><button className="reader-agent-toggle" onClick={() => { setAgentOpen(true); setAgentCollapsed(false); }}><Bot size={13} /> 询问 AI</button>
    </div>
    <div className="reader-main">
      <aside className={`reader-outline ${outlineCollapsed ? "collapsed" : ""}`} style={{ width: renderedOutlineWidth, flexBasis: renderedOutlineWidth }}>
        {outlineCollapsed ? <button className="reader-panel-expand" title="展开章节目录" onClick={() => setOutlineCollapsed(false)}><PanelLeftOpen size={16} /><span>目录</span></button> : <div className="reader-outline-scroll"><div className="reader-outline-heading"><span className="reader-outline-title">{mode === "pdf" ? `PDF 目录 · 第 ${pdfPage} 页` : "章节目录"}</span><button title="收起章节目录" onClick={() => setOutlineCollapsed(true)}><PanelLeftClose size={14} /></button></div>{sections.map((section, index) => <button key={section.id} className={activeSection === section.id ? "active" : ""} style={{ paddingLeft: `${10 + Math.max(0, section.level - 1) * 12}px` }} onClick={() => navigateToSection(section)}><b>{String(index + 1).padStart(2, "0")}</b><span>{section.title}</span><small>{section.pageStart ? section.pageStart === section.pageEnd ? `第 ${section.pageStart} 页` : `第 ${section.pageStart}-${section.pageEnd} 页` : `${section.blocks.length}`}</small></button>)}</div>}
        {!outlineCollapsed && <div className="reader-outline-resizer" role="separator" aria-label="调整目录宽度" aria-orientation="vertical" aria-valuemin={MIN_OUTLINE_WIDTH} aria-valuemax={MAX_OUTLINE_WIDTH} aria-valuenow={outlineWidth} tabIndex={0} title="拖动调整目录宽度" onPointerDown={(event) => { event.preventDefault(); event.currentTarget.focus(); outlineDrag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: outlineWidth }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={resizeOutline} onPointerUp={finishOutlineResize} onPointerCancel={finishOutlineResize} onKeyDown={resizeOutlineWithKeyboard} />}
      </aside>
      <main className={`reader-canvas reader-theme-${readerTheme}`} ref={readerCanvas}>
        {mode === "integrated" && <article className="integrated-paper">
          <header className="paper-reading-header"><span className="tag tag-primary">MD 章节阅读</span><h1>{paper.title}</h1><p>本地文档 · {paper.pageCount || "—"} 页 · 更新于 {new Date(paper.updatedAt).toLocaleDateString("zh-CN")}</p>{Boolean(uncertaintyQuery.data?.length) && <button className="document-uncertainty-link" onClick={() => { const page = uncertaintyQuery.data?.[0]?.page ?? 1; setPdfPage(page); setMode("pdf"); setPdfNavigationKey((value) => value + 1); }}><TriangleAlert size={13} /> {uncertaintyQuery.data?.length} 处需对照 PDF</button>}</header>
          {readerAnnotationsVisible && !hasPassageTranslations && <div className="reader-translation-empty"><div><Languages size={18} /><span><strong>当前还没有中文译文</strong><small>原始 Markdown 始终保持英文不变。翻译完成后，点击蓝色下划线即可在原位置切换中英文。</small></span></div><button className="primary-button compact" disabled={translationBatchBusy} onClick={() => credentialReady ? void translateCurrentSection() : setView("settings")}>{translationBatchBusy ? <LoaderCircle className="spin" size={14} /> : <Languages size={14} />} {credentialReady ? (translationBatchBusy ? "正在翻译本章" : "翻译当前章节") : "配置文本模型"}</button></div>}
          {markdownQuery.isLoading || documentQuery.isLoading ? <div className="document-loading">Loading structured document…</div> : sections.map((section, sectionIndex) => {
            const displayBlocks = section.blocks;
            return <section id={`reader-section-${section.id}`} data-section-id={section.id} className={`reading-section ${activeSection === section.id ? "active" : ""}`} key={section.id}>
            <header><div className="section-heading"><span className="section-kicker">章节 {String(sectionIndex + 1).padStart(2, "0")}</span><h2>{section.title}</h2><span>{section.pageStart ? section.pageStart === section.pageEnd ? `第 ${section.pageStart} 页` : `第 ${section.pageStart}-${section.pageEnd} 页` : "结构化内容"}</span></div><button disabled={contextBusy === section.id} onClick={() => void addContext(section.id, undefined, section.blocks.map((block) => block.text).join("\n\n"))}><Layers3 size={12} /> {contextDraftQuery.data?.items.some((item) => item.paperId === paper.id && item.sectionId === section.id && !item.blockId) ? "已添加" : "添加章节"}</button></header>
            <div className="paragraph-stack">{displayBlocks.map((block) => {
              const state = translations[block.id] ?? persistedTranslations[block.id];
              const hasFormula = /\$|\\\[|\\begin\{equation/.test(block.text);
              const explanationType = activeAnalysis?.blockId === block.id ? activeAnalysis.type : hasFormula ? "formula" : "theorem";
              const explanation = analysisStates[analysisKey(block.id, explanationType)];
              const blockTranslations = projectedTranslationsByBlock.get(block.id) ?? [];
              const blockAnnotations = (annotationQuery.data ?? []).filter((annotation) => annotation.blockId === block.id);
              return <div className={`paragraph-card ${block.compacted ? "compacted" : ""} ${activeBlock === block.id ? "active" : ""}`} key={block.id} onClick={(event) => { if (!(event.target as HTMLElement).closest("button, a")) setActiveBlock((current) => current === block.id ? "" : block.id); }} onMouseUp={(event) => captureSelection(block, event)}>
                <div className="paragraph-main"><div className="paragraph-markdown"><BilingualBlock block={block} state={state} records={blockTranslations} annotations={blockAnnotations} activeTranslationKeys={activeTranslationKeys} annotationsVisible={readerAnnotationsVisible} markdownPath={paper.markdownPath} figureAnalysisFor={figureAnalysisFor} onToggleFigure={(source) => void toggleFigureAnalysis(source)} onToggleTranslation={toggleInlineTranslation} onOpenAnnotation={openAnnotationInspector} onOpenTerm={openTermPanel} onLeaveTerm={scheduleTermPanelClose} onSentenceContextMenu={openSentenceMenu} /></div></div>
                <div className="paragraph-actions"><button className={state?.text ? "active" : ""} title={state?.status === "streaming" ? "停止翻译" : "翻译本段"} aria-label="翻译本段" onClick={() => void (state?.status === "streaming" ? cancelTranslation(block.id) : translate(block))}>{state?.status === "streaming" ? <LoaderCircle className="spin" size={14} /> : <Languages size={14} />}</button>{state?.status === "streaming" && <span className="paragraph-save-state live">{state.activityPhase === "connected" ? "已连接" : state.activityPhase === "thinking" ? "模型推理中" : state.activityPhase === "streaming" ? "生成译文中" : "请求中"}</span>}{state?.status === "unsaved" && <span className="paragraph-save-state"><LoaderCircle className="spin" size={11} /> 保存中</span>}<button title={hasFormula ? "解释公式" : "解释段落"} aria-label={hasFormula ? "解释公式" : "解释段落"} onClick={() => void (explanation?.status === "streaming" ? streamHandles.current.get(`analysis:${analysisKey(block.id, explanationType)}`)?.cancel() : explain(hasFormula ? "formula" : "theorem", block))}>{explanation?.status === "streaming" ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />}</button><button className={contextDraftQuery.data?.items.some((item) => item.paperId === paper.id && item.blockId === block.id) ? "active" : ""} title="加入论文上下文" aria-label="加入论文上下文" disabled={contextBusy === block.id} onClick={() => void addContext(block.sectionId, block.id, block.text)}><Layers3 size={14} /></button></div>
                {state?.slow && state.status === "streaming" && <div className="paragraph-slow-request"><TriangleAlert size={14} /><span><b>模型响应较慢</b><small>{state.reasoningCharacters ? `已接收 ${state.reasoningCharacters.toLocaleString()} 个推理字符，但还没有可用译文。` : "接口已连接，但还没有返回可用译文。"}</small></span><button onClick={() => updateTranslation(block.id, (current) => ({ ...current, slow: false }))}>继续等待</button><button className="danger" onClick={() => void cancelTranslation(block.id)}>停止</button></div>}
                {state?.error && <p className="paragraph-translation-error"><TriangleAlert size={12} /> {state.error}</p>}
                {explanation?.status === "error" && <p className="paragraph-translation-error"><TriangleAlert size={12} /> {explanation.error}</p>}
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
          {!credentialReady && <div className="reader-model-required"><Bot size={18} /><div><strong>{selectedModel ? "模型密钥尚未就绪" : "先配置一个文本模型"}</strong><span>配置后即可翻译、解释并与当前论文多轮对话。</span></div><button onClick={() => setView("settings")}>前往配置</button></div>}
          <div className="agent-chat-summary"><div><strong>本篇论文上下文</strong><b>{contextPercent}%</b></div><div className="context-track"><i style={{ width: `${contextPercent}%` }} /></div><span>{(contextUsed / 1000).toFixed(1)}K / {(maxContextTokens / 1000).toFixed(0)}K · {contextDraftQuery.data?.items.length ?? 0} 项</span><button className={contextManagerOpen ? "active" : ""} title="管理本篇论文上下文" onClick={() => setContextManagerOpen((value) => !value)}><Layers3 size={11} /></button>{Boolean(chatQuery.data?.turns.length) && <button title="清空对话" onClick={() => void clearChat()}><Trash2 size={11} /></button>}</div>
          {contextManagerOpen && <section className="paper-context-manager">
            <header><strong>上下文管理</strong><button title="新增自定义文字" onClick={() => setContextEditor({ title: "阅读笔记", text: "" })}><Plus size={12} /></button><button title="恢复默认 Markdown 全文" onClick={() => void restorePaperContext()}><RotateCcw size={12} /></button></header>
            <div className="paper-context-list">{contextDraftQuery.data?.items.map((item) => <article key={item.id}><div><b>{item.title || (item.itemType === "compressed_markdown" ? "AI 压缩后的原文" : item.itemType === "custom" ? "自定义文字" : "MD 原文")}</b><small>{item.estimatedTokens.toLocaleString()} tokens</small></div><p>{item.sourcePreview}</p><footer>{item.itemType === "custom" && <button onClick={() => void editContextItem(item.id)}>编辑</button>}<button className="danger" onClick={() => void deleteContextItem(item.id)}>移除</button></footer></article>)}</div>
            {contextEditor && <div className="paper-context-editor"><input value={contextEditor.title} onChange={(event) => setContextEditor({ ...contextEditor, title: event.target.value })} placeholder="上下文名称" /><textarea value={contextEditor.text} onChange={(event) => setContextEditor({ ...contextEditor, text: event.target.value })} placeholder="输入需要随论文对话携带的自定义文字" /><footer><button onClick={() => setContextEditor(null)}>取消</button><button className="primary" disabled={!contextEditor.text.trim()} onClick={() => void saveContextItem()}>保存</button></footer></div>}
          </section>}
          <label className="agent-model-field"><span>论文分析模型</span><select value={agentModel} onChange={(event) => setAgentModel(event.target.value)}><option value="">未配置</option>{customModels.map((model) => <option key={model.id} value={model.id}>{model.displayName} · {providers.find((provider) => provider.id === model.providerId)?.format ?? "不可用"}</option>)}</select></label>
          <label className="agent-model-field"><span>阅读助手提示词</span><select value={readerPrompt?.id ?? ""} onChange={(event) => choosePrompt("reader", event.target.value)}>{promptTemplates.filter((template) => template.category === "reader").map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>
          <div className="agent-chat-thread">
            {!chatQuery.data?.turns.length && chatStatus !== "streaming" && <div className="agent-chat-empty"><MessageSquareText size={18} /><strong>询问这篇论文</strong><span>默认携带本篇 Markdown 原文，并保留每轮上下文快照。</span></div>}
            {(chatQuery.data?.turns ?? []).map((turn) => <div className="agent-chat-turn" key={turn.id}>
              <div className="chat-message user"><span>You</span><p>{turn.userMessage}</p></div>
              <div className={`chat-message assistant ${turn.response?.status ?? "pending"}`}><span>论文分析助手{turn.response ? ` · 修订 ${turn.response.revision}` : ""}</span>{turn.response?.assistantText ? <div className="chat-markdown"><MarkdownBlock value={turn.response.assistantText} /></div> : <p>{turn.response?.error ?? "没有生成回答。"}</p>}<footer><small>{turn.response?.status ?? "等待中"}{turn.response?.usage ? ` · ${turn.response.usage.outputTokens} tokens · ${(turn.response.usage.durationMs / 1000).toFixed(1)}s` : ""}</small><div><button title="查看、编辑或删除这轮问答" onClick={(event) => openAnnotationInspector("chat", turn.id, [], event.currentTarget.getBoundingClientRect())}>管理</button>{turn.response?.assistantText && <button className={contextDraftQuery.data?.items.some((item) => item.paperId === paper.id && item.blockId === `chat:${turn.id}`) ? "active" : ""} onClick={() => void addContext("reader-chat", `chat:${turn.id}`, `用户问题：\n${turn.userMessage}\n\nAI 回答：\n${turn.response!.assistantText}`)}><Layers3 size={10} /> {contextDraftQuery.data?.items.some((item) => item.paperId === paper.id && item.blockId === `chat:${turn.id}`) ? "已加入" : "加入上下文"}</button>}{turn.response && turn.response.status !== "completed" && <button onClick={() => void sendChat(turn)}><RefreshCw size={10} /> 重试</button>}</div></footer></div>
            </div>)}
            {chatStatus === "streaming" && <div className="agent-chat-turn live"><div className="chat-message user"><span>You</span><p>{chatPendingQuestion}</p></div><div className="chat-message assistant streaming"><span><LoaderCircle className="spin" size={11} /> Paper Analyst</span>{chatLive ? <div className="chat-markdown"><MarkdownBlock value={chatLive} /></div> : <p>Waiting for the first model token…</p>}<footer><button onClick={() => void cancelChat()}><Square size={9} /> Cancel</button></footer></div></div>}
            {chatError && <p className="agent-chat-error"><TriangleAlert size={12} /> {chatError}</p>}
          </div>
        </div>}
        {!agentCollapsed && <form className="agent-chat-input" onSubmit={(event) => { event.preventDefault(); if (credentialReady) void sendChat(); else setView("settings"); }}><MessageSquareText size={13} /><input aria-label="询问这篇论文" value={chatInput} onChange={(event) => setChatInput(event.target.value)} disabled={chatStatus === "streaming" || !credentialReady} placeholder={credentialReady ? "输入关于这篇论文的问题…" : "配置文本模型后开始提问"} /><button title={credentialReady ? "发送" : "配置文本模型"} type="submit" disabled={!credentialReady || !chatInput.trim() || chatStatus === "streaming"}><Send size={13} /></button></form>}
      </aside>
    </div>
    <footer className="reader-context-bar"><Layers3 size={14} /><strong>本篇论文上下文</strong><span className="tag tag-primary">{contextDraftQuery.data?.items.length ?? 0} 个条目</span><div className="context-track"><i style={{ width: `${contextPercent}%` }} /></div><code>{(contextUsed / 1000).toFixed(1)}K / {(maxContextTokens / 1000).toFixed(0)}K · {contextPercent}%</code><span>与多论文研究上下文独立。</span><button onClick={() => { setAgentOpen(true); setAgentCollapsed(false); setContextManagerOpen(true); }}>管理</button></footer>
  </div>;
}

function TranslationPanel({ block, state, compact = false, onSave, onRetry, onCancel, onSpeak, onAddContext, inContext }: { block: ReaderBlock; state: TranslationState; compact?: boolean; onSave: () => void; onRetry: () => void; onCancel: () => void; onSpeak?: () => void; onAddContext: () => void; inContext: boolean }) {
  const word = state.kind === "word";
  return <div className={`translation-result ${word ? "word-lookup" : ""} ${compact ? "compact" : ""} ${state.status}`} data-block-id={block.id}>
    <div><span className="tag tag-ai">{word ? `论文语境词典 · ${block.text}` : "中文翻译"}{state.record ? ` · 修订 ${state.record.revision}` : ""}</span>{state.status === "saved" && <span className="tag tag-success"><Check size={10} /> 已保存</span>}</div>
    {state.activityPhase && state.status !== "saved" && <InlineModelStatus phase={state.activityPhase} startedAt={state.startedAt} receivedCharacters={state.receivedCharacters} reasoningCharacters={state.reasoningCharacters} />}
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

function InlineModelStatus({ phase, startedAt, receivedCharacters = 0, reasoningCharacters = 0 }: { phase: ModelActivityPhase; startedAt?: number; receivedCharacters?: number; reasoningCharacters?: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (["completed", "cancelled", "error"].includes(phase)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [phase]);
  const label = phase === "preparing" ? "正在准备请求" : phase === "sending" ? "正在连接模型" : phase === "connected" ? "模型接口已连接，等待首个 token" : phase === "thinking" ? "模型正在推理，尚未生成正文" : phase === "streaming" ? "已收到模型响应，正在生成" : phase === "saving" ? "正在校验并保存" : phase === "error" ? "模型调用失败" : phase === "cancelled" ? "已取消" : "已完成";
  const elapsed = startedAt ? Math.max(0, (now - startedAt) / 1000).toFixed(1) : "0.0";
  return <div className={`inline-model-status ${phase}`}><span><LoaderCircle className={["completed", "cancelled", "error"].includes(phase) ? "" : "spin"} size={13} /> {label}</span><b>{elapsed} 秒</b>{receivedCharacters > 0 ? <small>{receivedCharacters.toLocaleString()} 字符</small> : reasoningCharacters > 0 ? <small>{reasoningCharacters.toLocaleString()} 推理字符</small> : null}<i /></div>;
}
