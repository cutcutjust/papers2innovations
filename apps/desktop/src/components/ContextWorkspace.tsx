import type { ContextDraft, ContextDraftItem, ContextCompressionRecord, LibraryPaper, ModelStreamEvent } from "@p2i/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Database, FileText, Layers3, LoaderCircle, Minus, Plus, RefreshCw, Search, Sparkles, Square, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  activateContextCompression,
  addPaperToContext,
  clearContext,
  getContextCompression,
  getContextDraft,
  readContextItem,
  removePaperFromContext,
  saveContextCompression,
  startModelStream,
  type ModelStreamHandle,
} from "../lib/bridge";
import { CONTEXT_COMPRESSION_PROMPT_VERSION, contextCompressionBudgetError, contextCompressionMessages } from "../lib/contextCompression";
import { hydrateProviderCredentials } from "../lib/credentials";
import { useWorkspace } from "../store";

type CompressionState = {
  status: "loading" | "streaming" | "saving" | "saved" | "cancelled" | "error";
  text: string;
  error?: string;
  cacheHit?: boolean;
  record?: ContextCompressionRecord;
  usage?: { inputTokens: number; outputTokens: number };
};

const totalTokens = (draft: ContextDraft | undefined) => draft
  ? Object.values(draft.tokenBreakdown).reduce((total, value) => total + value, 0)
  : 0;

export function ContextWorkspace({ papers, root }: { papers: LibraryPaper[]; root: string }) {
  const {
    customModels,
    providers,
    contextCompressionModelId,
    setContextCompressionModelId,
  } = useWorkspace();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("");
  const [busyPaper, setBusyPaper] = useState("");
  const [error, setError] = useState("");
  const [compressionStates, setCompressionStates] = useState<Record<string, CompressionState>>({});
  const streamHandles = useRef(new Map<string, ModelStreamHandle>());
  const streamTexts = useRef(new Map<string, string>());
  const streamStartedAt = useRef(new Map<string, number>());
  const terminalItems = useRef(new Set<string>());
  const contextQuery = useQuery({
    queryKey: ["context-draft", root],
    queryFn: () => getContextDraft(root),
    retry: false,
  });
  const providerCredentialQuery = useQuery({
    queryKey: ["provider-credentials", providers.map((provider) => provider.credentialId).sort().join(":")],
    queryFn: () => hydrateProviderCredentials(providers),
    retry: false,
  });
  const selectedModel = customModels.find((model) => model.id === contextCompressionModelId) ?? customModels[0];
  const selectedProvider = providers.find((provider) => provider.id === selectedModel?.providerId);
  const credentialReady = Boolean(selectedProvider && providerCredentialQuery.data?.some(
    (summary) => summary.credentialId === selectedProvider.credentialId && summary.configured,
  ));
  const draft = contextQuery.data;
  const itemsByPaper = useMemo(() => new Map(papers.map((paper) => [
    paper.id,
    draft?.items.filter((item) => item.paperId === paper.id) ?? [],
  ])), [draft?.items, papers]);
  const visiblePapers = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? papers.filter((paper) => paper.title.toLowerCase().includes(needle)) : papers;
  }, [filter, papers]);
  const tokenUse = totalTokens(draft);
  const maxContext = selectedModel?.maxContextTokens ?? 128000;
  const percent = Math.min(100, Math.round(tokenUse / maxContext * 100));
  const includedPaperIds = new Set(draft?.items.map((item) => item.paperId) ?? []);

  useEffect(() => () => {
    for (const handle of streamHandles.current.values()) {
      handle.dispose();
      void handle.cancel();
    }
    streamHandles.current.clear();
  }, []);

  const update = async (paperId: string, action: () => Promise<ContextDraft>) => {
    setBusyPaper(paperId);
    setError("");
    try {
      const result = await action();
      queryClient.setQueryData(["context-draft", root], result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyPaper("");
    }
  };

  const updateCompression = (itemId: string, next: (current: CompressionState) => CompressionState) => {
    setCompressionStates((current) => ({
      ...current,
      [itemId]: next(current[itemId] ?? { status: "loading", text: "" }),
    }));
  };

  const refreshDraft = async () => {
    const refreshed = await getContextDraft(root);
    queryClient.setQueryData(["context-draft", root], refreshed);
    return refreshed;
  };

  const ensurePaperItem = async (paper: LibraryPaper, current?: ContextDraftItem) => {
    if (current) return current;
    const nextDraft = await addPaperToContext(root, paper.id, "full");
    queryClient.setQueryData(["context-draft", root], nextDraft);
    const item = nextDraft.items.find((candidate) => candidate.paperId === paper.id && !candidate.sectionId && !candidate.blockId);
    if (!item) throw new Error("The full paper could not be added to Context.");
    return item;
  };

  const finishCompression = async (item: ContextDraftItem, modelId: string, usage?: { inputTokens: number; outputTokens: number }) => {
    const compressedText = streamTexts.current.get(item.id)?.trim() ?? "";
    if (!compressedText) throw new Error("The model returned an empty compression.");
    updateCompression(item.id, (current) => ({ ...current, status: "saving", usage }));
    const record = await saveContextCompression(root, {
      itemId: item.id,
      sourceHash: item.sourceHash,
      compressedText,
      modelId,
      promptVersion: CONTEXT_COMPRESSION_PROMPT_VERSION,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      durationMs: Math.max(0, Date.now() - (streamStartedAt.current.get(item.id) ?? Date.now())),
    });
    await refreshDraft();
    updateCompression(item.id, () => ({ status: "saved", text: record.compressedText, record, usage, cacheHit: false }));
    setBusyPaper("");
  };

  const compressPaper = async (paper: LibraryPaper, current?: ContextDraftItem) => {
    if (!selectedModel || !selectedProvider) {
      setError("Configure a compression model and provider in Settings first.");
      return;
    }
    if (!credentialReady) {
      setError("Configure the selected compression model's API key in Settings first.");
      return;
    }
    setBusyPaper(paper.id);
    setError("");
    let item: ContextDraftItem | undefined;
    try {
      item = await ensurePaperItem(paper, current);
      updateCompression(item.id, () => ({ status: "loading", text: "" }));
      const cached = await getContextCompression(
        root,
        item.id,
        selectedModel.id,
        CONTEXT_COMPRESSION_PROMPT_VERSION,
      );
      if (cached) {
        const result = await activateContextCompression(
          root,
          item.id,
          selectedModel.id,
          CONTEXT_COMPRESSION_PROMPT_VERSION,
        );
        queryClient.setQueryData(["context-draft", root], result);
        updateCompression(item.id, () => ({ status: "saved", text: cached.compressedText, record: cached, cacheHit: true }));
        setBusyPaper("");
        return;
      }
      const source = await readContextItem(root, item.id);
      const budgetError = contextCompressionBudgetError(
        source.estimatedTokens,
        selectedModel.maxContextTokens,
        selectedModel.maxOutputTokens,
      );
      if (budgetError) throw new Error(budgetError);
      streamTexts.current.set(item.id, "");
      streamStartedAt.current.set(item.id, Date.now());
      terminalItems.current.delete(item.id);
      updateCompression(item.id, () => ({ status: "streaming", text: "" }));
      const requestId = crypto.randomUUID();
      const capturedItem = item;
      const onEvent = (event: ModelStreamEvent) => {
        if (event.kind === "delta" && event.text) {
          const text = (streamTexts.current.get(capturedItem.id) ?? "") + event.text;
          streamTexts.current.set(capturedItem.id, text);
          updateCompression(capturedItem.id, (state) => ({ ...state, status: "streaming", text }));
          return;
        }
        if (event.kind === "done") {
          terminalItems.current.add(capturedItem.id);
          void finishCompression(capturedItem, selectedModel.id, event.usage).catch((cause) => {
            updateCompression(capturedItem.id, (state) => ({ ...state, status: "error", error: cause instanceof Error ? cause.message : String(cause) }));
            setBusyPaper("");
          });
        } else if (event.kind === "cancelled") {
          terminalItems.current.add(capturedItem.id);
          updateCompression(capturedItem.id, (state) => ({ ...state, status: "cancelled" }));
          setBusyPaper("");
        } else if (event.kind === "error") {
          terminalItems.current.add(capturedItem.id);
          updateCompression(capturedItem.id, (state) => ({ ...state, status: "error", error: event.error ?? "Model request failed." }));
          setBusyPaper("");
        }
        if (["done", "cancelled", "error"].includes(event.kind)) {
          streamHandles.current.get(capturedItem.id)?.dispose();
          streamHandles.current.delete(capturedItem.id);
        }
      };
      const handle = await startModelStream({
        requestId,
        provider: selectedProvider,
        model: selectedModel,
        temperature: 0.1,
        messages: contextCompressionMessages(source),
      }, onEvent);
      if (terminalItems.current.has(item.id)) handle.dispose();
      else streamHandles.current.set(item.id, handle);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (item) updateCompression(item.id, (state) => ({ ...state, status: "error", error: message }));
      else setError(message);
      setBusyPaper("");
    }
  };

  const cancelCompression = async (itemId: string) => {
    await streamHandles.current.get(itemId)?.cancel();
  };

  const switchPaperMode = async (paper: LibraryPaper, mode: "full" | "structured") => {
    const item = (itemsByPaper.get(paper.id) ?? []).find((candidate) => !candidate.sectionId && !candidate.blockId);
    if (item) await streamHandles.current.get(item.id)?.cancel();
    await update(paper.id, () => addPaperToContext(root, paper.id, mode));
    if (item) {
      setCompressionStates((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
    }
  };

  const addNextPaper = () => {
    const paper = papers.find((item) => !includedPaperIds.has(item.id));
    if (paper) void update(paper.id, () => addPaperToContext(root, paper.id, "full"));
  };

  return <div className="context-page">
    <header className="figma-page-header">
      <div><h1>Context Workspace</h1><p>Assemble and inspect exactly what your AI agents receive</p></div>
      <div className="page-actions">
        <label className="context-compression-model"><Sparkles size={12} /><span>Compression model</span><select value={selectedModel?.id ?? ""} onChange={(event) => setContextCompressionModelId(event.target.value)}>{customModels.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select></label>
        <button className="secondary-button" disabled={!draft?.items.length || Boolean(busyPaper)} onClick={() => void update("clear", () => clearContext(root))}><Trash2 size={13} /> Clear</button>
        <button className="primary-button compact" disabled={includedPaperIds.size === papers.length || Boolean(busyPaper)} onClick={addNextPaper}><Plus size={13} /> Add paper</button>
      </div>
    </header>
    {error && <div className="settings-status error"><TriangleAlert size={15} /> {error}</div>}
    <div className="context-overview">
      <div><span>Current context</span><strong>{(tokenUse / 1000).toFixed(1)}K <small>/ {(maxContext / 1000).toFixed(0)}K tokens</small></strong><div className="context-track"><i style={{ width: `${percent}%` }} /></div></div>
      <dl><div><dt>Papers</dt><dd>{includedPaperIds.size}</dd></div><div><dt>Capacity used</dt><dd>{percent}%</dd></div><div><dt>Output reserve</dt><dd>{((draft?.tokenBreakdown.outputReserve ?? 16000) / 1000).toFixed(0)}K</dd></div><div><dt>Safety buffer</dt><dd>{((draft?.tokenBreakdown.safetyBuffer ?? 8000) / 1000).toFixed(0)}K</dd></div></dl>
    </div>
    <div className="context-layout">
      <section className="context-paper-panel">
        <header><div><h2>Paper sources</h2><p>Persist original or AI-compressed papers with exact provenance</p></div><label><Search size={12} /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter sources" /></label></header>
        <div className="context-paper-rows">{visiblePapers.map((paper) => {
          const items = itemsByPaper.get(paper.id) ?? [];
          const enabled = items.length > 0;
          const paperItem = items.find((item) => !item.sectionId && !item.blockId);
          const mode = paperItem?.mode ?? (enabled ? "sections" : "full");
          const paperTokens = items.reduce((total, item) => total + item.estimatedTokens, 0);
          const busy = busyPaper === paper.id;
          const state = paperItem ? compressionStates[paperItem.id] : undefined;
          return <article className={!enabled ? "excluded" : ""} key={paper.id}>
            <button className="context-toggle" disabled={busy} title={enabled ? "Remove paper from Context" : "Add paper to Context"} onClick={() => void update(paper.id, () => enabled ? removePaperFromContext(root, paper.id) : addPaperToContext(root, paper.id, "full"))}>{enabled ? <Minus size={12} /> : <Plus size={12} />}</button>
            <span className="context-file-icon"><FileText size={15} /></span>
            <div className="context-paper-copy">
              <h3>{paper.title}</h3>
              <p>{paper.pageCount || "—"} pages · {paper.status} · {items.length} context item{items.length === 1 ? "" : "s"}</p>
              <div className="context-mode-switch">
                <button className={mode === "full" ? "active" : ""} disabled={busy} onClick={() => void switchPaperMode(paper, "full")}>Original text</button>
                <button className={mode === "structured" ? "active" : ""} disabled={busy} onClick={() => void switchPaperMode(paper, "structured")}>Structured document</button>
                <button className={mode === "compressed" ? "active ai" : ""} disabled={busy && state?.status !== "streaming"} onClick={() => void compressPaper(paper, paperItem)}><Sparkles size={11} /> AI compressed</button>
                {mode === "sections" && <span className="tag tag-ai">Reader selections</span>}
              </div>
              {state && <div className={`context-compression-status ${state.status}`}>
                {state.status === "loading" && <><LoaderCircle className="spin" size={12} /> Checking the revisioned cache…</>}
                {state.status === "streaming" && <><LoaderCircle className="spin" size={12} /> Streaming compressed context{state.text ? ` · ${state.text.length.toLocaleString()} characters` : "…"}<button onClick={() => void cancelCompression(paperItem!.id)}><Square size={9} /> Cancel</button></>}
                {state.status === "saving" && <><LoaderCircle className="spin" size={12} /> Saving compression with source provenance…</>}
                {state.status === "saved" && <><Check size={12} /> {state.cacheHit ? "Cache hit · no new model call" : "Compressed context saved"}{state.record ? ` · revision ${state.record.revision}` : ""}</>}
                {state.status === "cancelled" && <>Compression cancelled.<button onClick={() => void compressPaper(paper, paperItem)}><RefreshCw size={10} /> Retry</button></>}
                {state.status === "error" && <><TriangleAlert size={12} /> {state.error}<button onClick={() => void compressPaper(paper, paperItem)}><RefreshCw size={10} /> Retry</button></>}
              </div>}
              {mode === "compressed" && paperItem?.compression && <p className="context-compression-preview"><Database size={11} /> {paperItem.compression.preview}<span>{paperItem.compression.modelId} · r{paperItem.compression.revision}</span></p>}
            </div>
            <code>{enabled ? `${(paperTokens / 1000).toFixed(1)}K` : "Excluded"}</code>
          </article>;
        })}</div>
      </section>
      <aside className="context-breakdown">
        <h2>Token breakdown</h2>
        {[
          ["System prompt", draft?.tokenBreakdown.systemPrompt ?? 4200],
          ["Agent tools", draft?.tokenBreakdown.tools ?? 7800],
          ["Conversation", draft?.tokenBreakdown.conversation ?? 0],
          ["Paper context", draft?.tokenBreakdown.papers ?? 0],
          ["Output reserve", draft?.tokenBreakdown.outputReserve ?? 16000],
          ["Safety buffer", draft?.tokenBreakdown.safetyBuffer ?? 8000],
        ].map(([label, value]) => <div className="breakdown-row" key={String(label)}><span>{label}</span><b>{(Number(value) / 1000).toFixed(1)}K</b><i><em style={{ width: `${Math.min(100, Number(value) / maxContext * 100)}%` }} /></i></div>)}
        <div className="context-policy"><Layers3 size={15} /><div><strong>Revisioned compression</strong><p>Cache identity includes the paper hash, model and prompt version. Source changes cannot reuse stale compressed evidence.</p></div></div>
      </aside>
    </div>
  </div>;
}
