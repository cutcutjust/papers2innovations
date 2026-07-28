import type { ContextDraft, ContextDraftItem, ContextCompressionRecord, LibraryPaper, ModelStreamEvent, ModelToolDefinition } from "@p2i/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Braces, Check, ChevronDown, Database, FileText, Gauge, Layers3, LoaderCircle, MessageSquareText, Minus, Plus, RefreshCw, Search, ShieldCheck, Sparkles, Square, Trash2, TriangleAlert, Wrench } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  activateContextCompression,
  addPaperToContext,
  clearContext,
  getContextCompression,
  getContextDraft,
  listAgentProfiles,
  listAgentTools,
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

type BreakdownKey = "system" | "tools" | "conversation" | "papers" | "figures" | "output" | "safety";

const estimateTokens = (text: string) => Math.max(0, Math.ceil(new TextEncoder().encode(text).length / 4));

const toolDisplayNames: Record<string, string> = {
  search_library: "搜索本地论文库",
  read_paper: "读取结构化论文",
  read_section: "读取论文章节",
  read_figure: "读取插图及说明",
  find_evidence: "查找证据锚点",
  get_references: "读取参考文献",
  get_related_papers: "查找相关论文",
  count_context_tokens: "计算上下文 token",
  create_note: "保存研究笔记",
  update_context: "更新共享上下文",
};

const toolDisplayName = (name: string) => toolDisplayNames[name] ?? name;

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
  const [expandedBreakdown, setExpandedBreakdown] = useState<BreakdownKey | null>("papers");
  const [inspectionAgentId, setInspectionAgentId] = useState("");
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
  const agentProfilesQuery = useQuery({
    queryKey: ["agent-profiles", root],
    queryFn: () => listAgentProfiles(root),
    retry: false,
  });
  const inspectedAgent = agentProfilesQuery.data?.find((profile) => profile.id === inspectionAgentId)
    ?? agentProfilesQuery.data?.find((profile) => profile.enabled)
    ?? agentProfilesQuery.data?.[0];
  const agentToolsQuery = useQuery({
    queryKey: ["agent-tools", root, inspectedAgent?.id],
    queryFn: () => listAgentTools(root, inspectedAgent!.id),
    enabled: Boolean(inspectedAgent?.id && expandedBreakdown === "tools"),
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

  useEffect(() => {
    if (!inspectionAgentId && agentProfilesQuery.data?.[0]) setInspectionAgentId(agentProfilesQuery.data[0].id);
  }, [agentProfilesQuery.data, inspectionAgentId]);

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

  const switchPaperMode = async (paper: LibraryPaper) => {
    const item = (itemsByPaper.get(paper.id) ?? []).find((candidate) => !candidate.sectionId && !candidate.blockId);
    if (item) await streamHandles.current.get(item.id)?.cancel();
    await update(paper.id, () => addPaperToContext(root, paper.id, "full"));
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

  const breakdownItems: Array<{ key: BreakdownKey; label: string; value: number; icon: typeof Layers3 }> = [
    { key: "system", label: "系统提示词", value: draft?.tokenBreakdown.systemPrompt ?? 4200, icon: Braces },
    { key: "tools", label: "智能体工具", value: draft?.tokenBreakdown.tools ?? 7800, icon: Wrench },
    { key: "conversation", label: "对话历史", value: draft?.tokenBreakdown.conversation ?? 0, icon: MessageSquareText },
    { key: "papers", label: "论文上下文", value: draft?.tokenBreakdown.papers ?? 0, icon: FileText },
    { key: "figures", label: "图像上下文", value: draft?.tokenBreakdown.figures ?? 0, icon: Database },
    { key: "output", label: "回答输出预留", value: draft?.tokenBreakdown.outputReserve ?? 16000, icon: Gauge },
    { key: "safety", label: "安全余量", value: draft?.tokenBreakdown.safetyBuffer ?? 8000, icon: ShieldCheck },
  ];

  return <div className="context-page">
    <header className="figma-page-header">
      <div><h1>上下文工作区</h1><p>组合并检查智能体实际使用的论文证据与 token 预算</p></div>
      <div className="page-actions">
        <label className="context-compression-model"><Sparkles size={12} /><span>压缩模型</span><select value={selectedModel?.id ?? ""} onChange={(event) => setContextCompressionModelId(event.target.value)}>{customModels.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select></label>
        <button className="secondary-button" disabled={!draft?.items.length || Boolean(busyPaper)} onClick={() => void update("clear", () => clearContext(root))}><Trash2 size={13} /> 清空</button>
        <button className="primary-button compact" disabled={includedPaperIds.size === papers.length || Boolean(busyPaper)} onClick={addNextPaper}><Plus size={13} /> 添加论文</button>
      </div>
    </header>
    {error && <div className="settings-status error"><TriangleAlert size={15} /> {error}</div>}
    <div className="context-overview">
      <div><span>当前预算</span><strong>{(tokenUse / 1000).toFixed(1)}K <small>/ {(maxContext / 1000).toFixed(0)}K tokens</small></strong><div className="context-track"><i style={{ width: `${percent}%` }} /></div></div>
      <dl><div><dt>论文</dt><dd>{includedPaperIds.size}</dd></div><div><dt>预算占用</dt><dd>{percent}%</dd></div><div><dt>回答预留</dt><dd>{((draft?.tokenBreakdown.outputReserve ?? 16000) / 1000).toFixed(0)}K</dd></div><div><dt>安全余量</dt><dd>{((draft?.tokenBreakdown.safetyBuffer ?? 8000) / 1000).toFixed(0)}K</dd></div></dl>
    </div>
    <div className="context-layout">
      <section className="context-paper-panel">
        <header><div><h2>上下文来源</h2><p>只包含 MD 原文、AI 压缩后的原文，以及你主动加入的文字</p></div><label><Search size={12} /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="筛选来源" /></label></header>
        <div className="context-paper-rows">{visiblePapers.map((paper) => {
          const items = itemsByPaper.get(paper.id) ?? [];
          const enabled = items.length > 0;
          const paperItem = items.find((item) => !item.sectionId && !item.blockId);
          const mode = paperItem?.mode === "structured" ? "full" : paperItem?.mode ?? (enabled ? "sections" : "full");
          const paperTokens = items.reduce((total, item) => total + item.estimatedTokens, 0);
          const busy = busyPaper === paper.id;
          const state = paperItem ? compressionStates[paperItem.id] : undefined;
          return <article className={!enabled ? "excluded" : ""} key={paper.id}>
            <button className="context-toggle" disabled={busy} title={enabled ? "Remove paper from Context" : "Add paper to Context"} onClick={() => void update(paper.id, () => enabled ? removePaperFromContext(root, paper.id) : addPaperToContext(root, paper.id, "full"))}>{enabled ? <Minus size={12} /> : <Plus size={12} />}</button>
            <span className="context-file-icon"><FileText size={15} /></span>
            <div className="context-paper-copy">
              <h3>{paper.title}</h3>
              <p>{paper.pageCount || "—"} 页 · {paper.status} · {items.length} 个上下文条目</p>
              <div className="context-mode-switch">
                <button className={mode === "full" ? "active" : ""} disabled={busy} onClick={() => void switchPaperMode(paper)}>MD 原文</button>
                <button className={mode === "compressed" ? "active ai" : ""} disabled={busy && state?.status !== "streaming"} onClick={() => void compressPaper(paper, paperItem)}><Sparkles size={11} /> AI 压缩后的原文</button>
                {mode === "sections" && <span className="tag tag-ai">自定义加入的文字</span>}
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
            <code>{enabled ? `${(paperTokens / 1000).toFixed(1)}K` : "未加入"}</code>
          </article>;
        })}</div>
      </section>
      <aside className="context-breakdown">
        <div className="breakdown-heading"><div><h2>Token 预算与内容</h2><p>点击每项检查完整内容或计算规则</p></div>{Boolean(agentProfilesQuery.data?.length) && <label><span>检查智能体</span><select value={inspectedAgent?.id ?? ""} onChange={(event) => setInspectionAgentId(event.target.value)}>{agentProfilesQuery.data?.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>}</div>
        <div className="token-breakdown-list">{breakdownItems.map((item) => {
          const Icon = item.icon;
          const expanded = expandedBreakdown === item.key;
          return <div className={`breakdown-item ${expanded ? "expanded" : ""}`} key={item.key}>
            <button className="breakdown-row" aria-expanded={expanded} onClick={() => setExpandedBreakdown(expanded ? null : item.key)}><Icon size={14} /><span>{item.label}</span><b>{item.value.toLocaleString()} tokens</b><ChevronDown size={14} /><i><em style={{ width: `${Math.min(100, item.value / maxContext * 100)}%` }} /></i></button>
            {expanded && <TokenBreakdownDetail breakdownKey={item.key} budget={item.value} root={root} items={draft?.items ?? []} agent={inspectedAgent} tools={agentToolsQuery.data} toolsLoading={agentToolsQuery.isLoading} />}
          </div>;
        })}</div>
        <div className="context-policy"><Layers3 size={15} /><div><strong>版本化压缩缓存</strong><p>缓存键包含论文哈希、模型和提示词版本。来源发生变化后，不会复用过期的压缩证据。</p></div></div>
      </aside>
    </div>
  </div>;
}

function TokenBreakdownDetail({ breakdownKey, budget, root, items, agent, tools, toolsLoading }: {
  breakdownKey: BreakdownKey;
  budget: number;
  root: string;
  items: ContextDraftItem[];
  agent?: Awaited<ReturnType<typeof listAgentProfiles>>[number];
  tools?: ModelToolDefinition[];
  toolsLoading: boolean;
}) {
  if (breakdownKey === "system") {
    const text = agent?.systemPrompt ?? "尚未配置智能体系统提示词。";
    return <div className="breakdown-detail"><DetailHeader label={agent?.name ?? "未选择智能体"} actual={estimateTokens(text)} budget={budget} /><pre>{text}</pre></div>;
  }
  if (breakdownKey === "tools") {
    if (toolsLoading) return <div className="breakdown-detail loading"><LoaderCircle className="spin" size={14} /> 正在读取工具定义…</div>;
    const definitions = tools ?? [];
    const serialized = JSON.stringify(definitions, null, 2);
    return <div className="breakdown-detail"><DetailHeader label={`${definitions.length} 个已启用工具`} actual={estimateTokens(serialized)} budget={budget} />{definitions.length ? definitions.map((tool) => <article className="tool-definition" key={tool.name}><header><strong>{toolDisplayName(tool.name)}</strong><code>{tool.name}</code></header><p>{tool.description}</p><pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre></article>) : <p className="empty-detail">当前智能体未启用工具。</p>}</div>;
  }
  if (breakdownKey === "papers") {
    return <div className="breakdown-detail"><DetailHeader label={`${items.length} 个论文来源`} actual={items.reduce((total, item) => total + item.estimatedTokens, 0)} budget={budget} />{items.length ? items.map((item) => <ContextSourceDisclosure item={item} root={root} key={item.id} />) : <p className="empty-detail">尚未将论文或阅读器选段加入共享上下文。</p>}</div>;
  }
  if (breakdownKey === "conversation") return <BudgetExplanation budget={budget} title="当前没有对话文本" text="共享上下文草稿不自动混入 Reader 或智能体的历史对话。发起具体请求时，只会按该工作流的会话规则附加对话内容。" />;
  if (breakdownKey === "figures") return <BudgetExplanation budget={budget} title="当前没有图像上下文" text="只有明确加入上下文的插图、图注或视觉结果才会计入此处；论文正文中的图片路径不会自动作为视觉输入发送。" />;
  if (breakdownKey === "output") return <BudgetExplanation budget={budget} title="这是输出额度，不是输入文本" text={`共享草稿预留 ${budget.toLocaleString()} tokens，确保模型有空间生成回答。${agent ? `当前“${agent.name}”配置的单次最大输出为 ${agent.maxOutputTokens.toLocaleString()} tokens，执行时以具体智能体配置为准。` : "执行时会以具体智能体的最大输出配置为准。"}`} />;
  return <BudgetExplanation budget={budget} title="这是防超限余量，不是输入文本" text="该余量用于覆盖 tokenizer 差异、消息角色包装、工具调用参数和供应商协议开销。它不会发送给模型，也不包含论文或提示词内容。" />;
}

function DetailHeader({ label, actual, budget }: { label: string; actual: number; budget: number }) {
  return <header className="detail-token-header"><strong>{label}</strong><span>当前内容估算 <b>{actual.toLocaleString()}</b> · 预算 <b>{budget.toLocaleString()}</b></span></header>;
}

function BudgetExplanation({ budget, title, text }: { budget: number; title: string; text: string }) {
  return <div className="breakdown-detail budget-explanation"><header><strong>{title}</strong><code>{budget.toLocaleString()} tokens</code></header><p>{text}</p></div>;
}

function ContextSourceDisclosure({ item, root }: { item: ContextDraftItem; root: string }) {
  const [open, setOpen] = useState(false);
  const sourceQuery = useQuery({
    queryKey: ["context-source", root, item.id],
    queryFn: () => readContextItem(root, item.id),
    enabled: open,
    retry: false,
  });
  return <details className="context-source-detail" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary><span><strong>{item.paperTitle}</strong><small>{item.sectionId ? "自定义加入的文字" : item.mode === "compressed" ? "AI 压缩后的原文" : "MD 原文"}</small></span><code>{item.estimatedTokens.toLocaleString()} tokens</code></summary>{sourceQuery.isLoading ? <p><LoaderCircle className="spin" size={13} /> 正在读取完整文本…</p> : sourceQuery.isError ? <p className="detail-error"><TriangleAlert size={13} /> {sourceQuery.error instanceof Error ? sourceQuery.error.message : "无法读取该来源"}</p> : <pre>{sourceQuery.data?.sourceText ?? item.sourcePreview}</pre>}</details>;
}
