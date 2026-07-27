import type { LibraryPaper, ModelStreamEvent, PaperDocument, TranslationRecord } from "@p2i/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Bot, Check, ChevronLeft, FileImage, FileText, Languages, Layers3, LoaderCircle, MessageSquareText, RefreshCw, Search, Send, Sigma, Sparkles, Square, TriangleAlert } from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { addPaperToContext, addSelectionToContext, assetUrl, getContextDraft, listTranslations, readDocument, readMarkdown, removePaperFromContext, saveTranslation, startModelStream, type ModelStreamHandle } from "../lib/bridge";
import { hydrateProviderCredentials } from "../lib/credentials";
import { buildReaderBlocks, type ReaderDocumentBlock } from "../lib/documentBlocks";
import { useWorkspace } from "../store";

type ReaderMode = "integrated" | "pdf" | "figures";
type Analysis = "formula" | "theorem" | null;
type ReaderBlock = ReaderDocumentBlock;
type ReaderSection = { id: string; title: string; blocks: ReaderBlock[] };
type SelectionSource = ReaderBlock & { start: number; end: number };
type TranslationState = {
  status: "streaming" | "unsaved" | "saved" | "cancelled" | "error";
  text: string;
  error?: string;
  record?: TranslationRecord;
};

const TRANSLATION_PROMPT_VERSION = "reader-translate-v1";

function documentSections(document: PaperDocument | undefined, markdown: string): ReaderSection[] {
  if (document?.sections.length) {
    return [...document.sections]
      .sort((left, right) => left.order - right.order)
      .map((section) => ({
        id: section.id,
        title: section.title,
        blocks: buildReaderBlocks(section.id, section.markdown, section.anchors[0]?.page ?? section.page_start),
      }));
  }
  const blocks = buildReaderBlocks("paper", markdown);
  return [{ id: "paper", title: "Paper", blocks }];
}

function MarkdownBlock({ value }: { value: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{value}</ReactMarkdown>;
}

export function Reader({ paper, root }: { paper?: LibraryPaper; root: string }) {
  const { setView, customModels, providers } = useWorkspace();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<ReaderMode>("integrated");
  const [selection, setSelection] = useState<SelectionSource | null>(null);
  const [translations, setTranslations] = useState<Record<string, TranslationState>>({});
  const [analysis, setAnalysis] = useState<Analysis>(null);
  const [activeBlock, setActiveBlock] = useState("");
  const [contextBusy, setContextBusy] = useState("");
  const [agentModel, setAgentModel] = useState(customModels[0]?.id ?? "");
  const streamHandles = useRef(new Map<string, ModelStreamHandle>());
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
    () => documentSections(documentQuery.data, markdownQuery.data ?? ""),
    [documentQuery.data, markdownQuery.data],
  );
  const persistedTranslations = useMemo(
    () => Object.fromEntries((translationQuery.data ?? []).map((record) => [record.blockId, { status: "saved", text: record.translatedText, record } satisfies TranslationState])),
    [translationQuery.data],
  );
  const selectedModel = customModels.find((model) => model.id === agentModel) ?? customModels[0];
  const selectedProvider = providers.find((provider) => provider.id === selectedModel?.providerId);
  const maxContextTokens = selectedModel?.maxContextTokens ?? 128000;
  const tokenBreakdown = contextDraftQuery.data?.tokenBreakdown;
  const contextUsed = tokenBreakdown ? Object.values(tokenBreakdown).reduce((total, value) => total + value, 0) : 36000;
  const contextPercent = Math.min(100, Math.round(contextUsed / maxContextTokens * 100));
  const fullText = Boolean(paper && contextDraftQuery.data?.items.some(
    (item) => item.paperId === paper.id && !item.sectionId && !item.blockId,
  ));

  useEffect(() => {
    setTranslations({});
    setSelection(null);
    setActiveBlock("");
    for (const handle of streamHandles.current.values()) void handle.cancel();
    streamHandles.current.clear();
  }, [paper?.id]);

  useEffect(() => () => {
    for (const handle of streamHandles.current.values()) {
      handle.dispose();
      void handle.cancel();
    }
  }, []);

  if (!paper) return <main className="reader-empty"><BookOpen size={34} /><h2>No paper selected</h2><p>Choose a paper in Library, then open it in Reader.</p><button className="primary-button compact" onClick={() => setView("library")}>Open Library</button></main>;

  const credentialReady = Boolean(selectedProvider && providerCredentialQuery.data?.some(
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
    setAnalysis(null);
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

  const explain = (type: "formula" | "theorem", id: string) => { setActiveBlock(id); setAnalysis(type); };
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
  const captureSelection = (block: ReaderBlock) => {
    const selected = window.getSelection();
    const text = selected?.toString().trim();
    if (!text) return;
    const start = Math.min(selected?.anchorOffset ?? 0, selected?.focusOffset ?? 0);
    const end = Math.max(selected?.anchorOffset ?? text.length, selected?.focusOffset ?? text.length);
    setSelection({ ...block, id: `${block.id}:selection-${start}-${end}`, text: text.slice(0, 500), start, end });
  };

  return <div className="reader-workspace">
    <div className="reader-toolbar">
      <button onClick={() => setView("library")}><ChevronLeft size={13} /> Library</button>
      <strong title={paper.title}>{paper.title}</strong>
      <div className="reader-mode-switch"><button className={mode === "integrated" ? "active" : ""} onClick={() => setMode("integrated")}>Integrated Reading</button><button className={mode === "pdf" ? "active" : ""} onClick={() => setMode("pdf")}>PDF Only</button><button className={mode === "figures" ? "active" : ""} onClick={() => setMode("figures")}>Figures</button></div>
      <button><Search size={13} /> Find</button><button className={fullText ? "active" : ""} disabled={contextBusy === "paper"} onClick={() => void togglePaperContext()}><Layers3 size={13} /> {fullText ? `Paper Context · ${contextPercent}%` : "Load Full Text"}</button>
    </div>
    <div className="reader-main">
      <aside className="reader-outline"><span>Outline</span>{sections.map((section, index) => <button key={section.id} className={index === 0 ? "active" : ""}>{section.title}<small>{section.blocks.length}</small></button>)}</aside>
      <main className="reader-canvas">
        {mode === "integrated" && <article className="integrated-paper">
          <header className="paper-reading-header"><span className="tag tag-primary">STRUCTURED DOCUMENT</span><h1>{paper.title}</h1><p>Local document · {paper.pageCount || "—"} pages · Updated {new Date(paper.updatedAt).toLocaleDateString()}</p></header>
          {selection && <div className="selection-toolbar"><span className="tag tag-ai">Selected {selection.start}:{selection.end}</span><strong>“{selection.text.slice(0, 64)}”</strong><button onClick={() => void translate(selection)}><Languages size={12} /> Translate word</button><button onClick={() => explain("theorem", selection.id)}><Sparkles size={12} /> Explain</button><button onClick={() => setSelection(null)}>Close</button></div>}
          {markdownQuery.isLoading || documentQuery.isLoading ? <div className="document-loading">Loading structured document…</div> : sections.map((section, sectionIndex) => <section className={`reading-section ${sectionIndex === 0 ? "active" : ""}`} key={section.id}>
            <header><div><h2>{section.title}</h2><span>{section.blocks.length} paragraphs · structured source</span></div><button disabled={contextBusy === section.id} onClick={() => void addContext(section.id, undefined, section.blocks.map((block) => block.text).join("\n\n"))}><Layers3 size={12} /> {contextDraftQuery.data?.items.some((item) => item.paperId === paper.id && item.sectionId === section.id && !item.blockId) ? "Added" : "Add Section"}</button></header>
            <div className="paragraph-stack">{section.blocks.map((block, blockIndex) => {
              const state = translations[block.id] ?? persistedTranslations[block.id];
              const hasFormula = /\$|\\\[|\\begin\{equation/.test(block.text);
              return <div className={`paragraph-card ${activeBlock === block.id ? "active" : ""}`} key={block.id} onMouseUp={() => captureSelection(block)}>
                <div className="paragraph-main"><span className="paragraph-number">{sectionIndex ? `${sectionIndex}.${blockIndex + 1}` : `A${blockIndex + 1}`}</span><div className="paragraph-markdown"><MarkdownBlock value={block.text} /></div><div className="paragraph-actions"><button onClick={() => void translate(block)}><Languages size={12} /> Translate</button><button onClick={() => explain(hasFormula ? "formula" : "theorem", block.id)}><Sparkles size={12} /> Explain</button><button disabled={contextBusy === block.id} onClick={() => void addContext(block.sectionId, block.id, block.text)}><Layers3 size={12} /> {contextDraftQuery.data?.items.some((item) => item.paperId === paper.id && item.blockId === block.id) ? "Added" : "Add"}</button></div></div>
                {state && <TranslationPanel block={block} state={state} onSave={() => void persistTranslation(block, state)} onRetry={() => void translate(block)} onCancel={() => void cancelTranslation(block.id)} />}
                {analysis && activeBlock === block.id && <AnalysisCard type={analysis} />}
              </div>;
            })}</div>
          </section>)}
        </article>}
        {mode === "pdf" && <div className="integrated-pdf">{assetUrl(paper.sourcePath) ? <iframe title="Source PDF" src={assetUrl(paper.sourcePath)} /> : <div className="pdf-placeholder"><FileText size={38} /><h2>Native PDF preview</h2><p>The source PDF is displayed here in the Windows desktop build.</p></div>}</div>}
        {mode === "figures" && <div className="reader-figures">{paper.figures.length ? paper.figures.map((figure) => <figure key={figure.id}>{assetUrl(`${paper.markdownPath?.replace(/[\\/][^\\/]+$/, "")}/${figure.relativePath}`) ? <img src={assetUrl(`${paper.markdownPath?.replace(/[\\/][^\\/]+$/, "")}/${figure.relativePath}`)} alt={figure.caption ?? "Extracted figure"} /> : <div><FileImage size={32} /></div>}<figcaption>{figure.caption ?? "Extracted figure"}</figcaption></figure>) : <div className="pdf-placeholder"><FileImage size={36} /><h2>No extracted figures</h2><p>Figures will appear after the parser finishes extraction.</p></div>}</div>}
      </main>
      <aside className="reader-agent-panel">
        <header><Bot size={15} /><strong>Paper Analyst Agent</strong><span className={`tag ${credentialReady ? "tag-success" : "tag-warning"}`}>{credentialReady ? "Gateway ready" : selectedProvider ? "Needs key" : "Needs model"}</span></header>
        <div className="agent-panel-scroll"><p className="agent-intro">Translations stream through the secure Rust model gateway and can be persisted with exact section and block provenance.</p><div className="agent-context-card"><div><strong>Conversation Context</strong><b>{contextPercent}%</b></div><div className="context-track"><i style={{ width: `${contextPercent}%` }} /></div><p>{(contextUsed / 1000).toFixed(1)}K / {(maxContextTokens / 1000).toFixed(0)}K tokens · {contextDraftQuery.data?.items.length ?? 0} persisted items</p><button onClick={() => setView("context")}>Open Context Workspace</button></div><label className="agent-model-field"><span>Translation and agent model</span><select value={agentModel} onChange={(event) => setAgentModel(event.target.value)}>{customModels.map((model) => <option key={model.id} value={model.id}>{model.displayName} · {providers.find((provider) => provider.id === model.providerId)?.format ?? "unavailable"}</option>)}</select></label><div className="agent-tool-call"><span><Sparkles size={12} /> secure_model_gateway</span><b>Rust</b><code>provider: {selectedProvider?.name ?? "not configured"}<br />credential: {selectedProvider?.credentialId ?? "none"}</code></div><p className="agent-answer">API keys remain in Stronghold and Rust memory. Python, SQLite, logs and persisted React state receive no provider secret.</p></div>
        <label className="agent-chat-input"><MessageSquareText size={13} /><input placeholder="Ask about this paper…" /><Send size={13} /></label>
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

function AnalysisCard({ type }: { type: "formula" | "theorem" }) {
  return <div className={`reader-analysis ${type}`}><span className="tag tag-ai">AI {type === "formula" ? "Formula" : "Theorem"} Explanation · Gateway pending</span><h3>{type === "formula" ? "Formula intuition and term-by-term explanation" : "Claim, assumptions and proof sketch"}</h3>{type === "formula" ? <div className="formula-grid"><div><b>Inputs</b><p>Identifies each symbol and its role in the computation.</p></div><div><b>Operation</b><p>Explains the transformation and normalization step.</p></div><div><b>Output</b><p>Connects the result back to the surrounding method.</p></div></div> : <p><b>Next connection.</b> This panel will reuse the secure model stream with the source statement, proof and adjacent structured blocks.</p>}<footer><button disabled>Save Explanation</button><button>Show Source Evidence</button><button>Ask Follow-up</button></footer></div>;
}
