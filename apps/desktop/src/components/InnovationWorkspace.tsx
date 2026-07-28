import type { ContextSnapshot, InnovationRun, InnovationStageId, LibraryPaper, ModelStreamEvent } from "@p2i/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, FileText, LoaderCircle, Plus, RotateCcw, Save, Settings2, Sparkles, Square, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  addPaperToContext,
  cancelInnovationRun,
  clearContext,
  getContextCompression,
  getContextDraft,
  getInnovationPrompt,
  listInnovationRuns,
  nativeRuntime,
  readContextItem,
  removePaperFromContext,
  retryInnovationRun,
  saveInnovationPrompt,
  startInnovationRun,
  startInnovationStage,
  startModelStream,
  updateInnovationStage,
  type ModelStreamHandle,
} from "../lib/bridge";
import { hydrateProviderCredentials } from "../lib/credentials";
import { useWorkspace } from "../store";

const PROMPT_VERSION = "innovation-v1";
const defaultPrompt = [
  "请基于 {paper_context}，识别所选论文之间可迁移的机制、尚未解决的局限和相互矛盾的假设。",
  "",
  "生成 3 个可验证的研究想法。每个想法都应包含：",
  "1. 研究空白与证据引用",
  "2. 拟议机制及其可能有效的原因",
  "3. 可证伪假设",
  "4. 最小可行实验",
  "5. 创新性风险与最接近的已知工作",
  "",
  "不得编造证据。每项事实性陈述都要引用论文及对应页码或章节。默认使用中文输出。",
].join("\n");

const routes: Array<{ id: InnovationStageId; label: string; description: string }> = [
  { id: "compression", label: "上下文压缩", description: "生成保留锚点的跨论文摘要" },
  { id: "evidence", label: "证据提取", description: "提取论点、方法、局限和引用" },
  { id: "ideas", label: "想法生成", description: "根据可编辑提示词生成假设" },
  { id: "novelty", label: "创新性验证", description: "使用本地证据审查候选想法" },
  { id: "critique", label: "批判与实验", description: "压力测试论点并设计最小实验" },
];

function stageInstruction(stage: InnovationStageId, prompt: string, contextText: string, outputs: Partial<Record<InnovationStageId, string>>) {
  if (stage === "compression") return `请压缩以下研究上下文，同时保留每个论文/章节/页码锚点、机制、局限和不确定性。使用中文输出。\n\n${contextText}`;
  if (stage === "evidence") return `请建立结构化中文证据台账。每条记录必须包含来源锚点，并区分观察、方法、结果、局限和矛盾。\n\n上下文摘要：\n${outputs.compression}`;
  if (stage === "ideas") return `${prompt.replace("{paper_context}", outputs.evidence ?? "")}\n\n证据台账：\n${outputs.evidence}`;
  if (stage === "novelty") return `只能根据给定证据评估研究想法。识别最接近的本地工作、重复机制、薄弱前提和需要外部验证的论断。不得暗示已经执行网络搜索。使用中文输出。\n\n研究想法：\n${outputs.ideas}\n\n证据：\n${outputs.evidence}`;
  return `请生成最终中文研究简报。对每个通过审查的想法，给出有据可查的前提、可证伪假设、最小实验、混杂因素、失败标准、创新性风险和来源锚点。删除未能通过批判性审查的想法。\n\n研究想法：\n${outputs.ideas}\n\n创新性审查：\n${outputs.novelty}\n\n证据：\n${outputs.evidence}`;
}

function stageStatusLabel(run: InnovationRun | undefined, stage: InnovationStageId) {
  return run?.stages.find((item) => item.stage === stage)?.status ?? "pending";
}

function stageStatusText(status: string) {
  return ({ pending: "等待中", running: "运行中", completed: "已完成", failed: "失败", interrupted: "已中断", cancelled: "已取消" } as Record<string, string>)[status] ?? status;
}

export function InnovationWorkspace({ papers }: { papers: LibraryPaper[] }) {
  const { root, customModels, providers, setView } = useWorkspace();
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [routeModels, setRouteModels] = useState<Record<InnovationStageId, string>>(() => Object.fromEntries(routes.map((route) => [route.id, customModels[0]?.id ?? ""])) as Record<InnovationStageId, string>);
  const [notice, setNotice] = useState("准备就绪");
  const [activeRunId, setActiveRunId] = useState("");
  const [activeStage, setActiveStage] = useState<InnovationStageId | "">("");
  const [liveOutput, setLiveOutput] = useState("");
  const [busyPaper, setBusyPaper] = useState("");
  const streamHandle = useRef<ModelStreamHandle | null>(null);
  const checkpointTimer = useRef<number | null>(null);
  const activeRunRef = useRef("");

  const contextQuery = useQuery({ queryKey: ["context-draft", root], queryFn: () => getContextDraft(root), enabled: Boolean(root), retry: false });
  const promptQuery = useQuery({ queryKey: ["innovation-prompt", root, PROMPT_VERSION], queryFn: () => getInnovationPrompt(root, PROMPT_VERSION), enabled: Boolean(root), retry: false });
  const runsQuery = useQuery({ queryKey: ["innovation-runs", root], queryFn: () => listInnovationRuns(root), enabled: Boolean(root), retry: false, refetchInterval: activeRunId ? 2000 : false });
  const credentialsQuery = useQuery({
    queryKey: ["provider-credentials", providers.map((provider) => provider.credentialId).sort().join(":")],
    queryFn: () => hydrateProviderCredentials(providers),
    retry: false,
  });
  const configuredCredentials = useMemo(() => new Set((credentialsQuery.data ?? []).filter((item) => item.configured).map((item) => item.credentialId)), [credentialsQuery.data]);
  const latestRun = runsQuery.data?.[0];
  const context = contextQuery.data;
  const contextItemsByPaper = useMemo(() => new Map(papers.map((paper) => [paper.id, context?.items.filter((item) => item.paperId === paper.id) ?? []])), [context?.items, papers]);
  const includedPapers = papers.filter((paper) => (contextItemsByPaper.get(paper.id)?.length ?? 0) > 0);
  const contextUsed = context ? Object.values(context.tokenBreakdown).reduce((total, value) => total + value, 0) : 0;
  const modelLimit = Math.max(...Object.values(routeModels).map((id) => customModels.find((model) => model.id === id)?.maxContextTokens ?? 0), 128000);
  const contextPercent = Math.min(100, Math.round(contextUsed / modelLimit * 100));
  const running = Boolean(activeRunId);

  useEffect(() => {
    if (promptQuery.data?.promptText) setPrompt(promptQuery.data.promptText);
  }, [promptQuery.data]);

  useEffect(() => {
    const available = new Set(customModels.map((model) => model.id));
    const fallback = customModels[0]?.id ?? "";
    setRouteModels((current) => Object.fromEntries(routes.map((route) => [route.id, available.has(current[route.id]) ? current[route.id] : fallback])) as Record<InnovationStageId, string>);
  }, [customModels]);

  useEffect(() => () => {
    if (streamHandle.current) {
      void streamHandle.current.cancel();
      streamHandle.current.dispose();
    }
    if (activeRunRef.current) void cancelInnovationRun(root, activeRunRef.current).catch(() => undefined);
    if (checkpointTimer.current) window.clearTimeout(checkpointTimer.current);
  }, [root]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["innovation-runs", root] }),
      queryClient.invalidateQueries({ queryKey: ["innovation-prompt", root] }),
      queryClient.invalidateQueries({ queryKey: ["context-draft", root] }),
    ]);
  };

  const savePrompt = async () => {
    try {
      const saved = await saveInnovationPrompt(root, prompt, PROMPT_VERSION);
      setNotice(`Prompt revision ${saved.revision} saved locally.`);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const includePaper = async (paper: LibraryPaper, include: boolean) => {
    setBusyPaper(paper.id);
    try {
      if (include) await addPaperToContext(root, paper.id, "full");
      else await removePaperFromContext(root, paper.id);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyPaper("");
    }
  };

  const assembleContext = async (expected?: ContextSnapshot) => {
    const draft = await getContextDraft(root);
    const expectedItems = new Map((expected?.items ?? []).map((item) => [item.contextItemId, item]));
    const items = expected ? draft.items.filter((item) => expectedItems.has(item.id)) : draft.items;
    const content: string[] = [];
    const snapshotItems: ContextSnapshot["items"] = [];
    for (const item of items) {
      const expectedItem = expectedItems.get(item.id);
      if (expectedItem?.sourceHash && expectedItem.sourceHash !== item.sourceHash) throw new Error(`Context source changed for ${item.paperTitle}. Start a new pipeline.`);
      const source = await readContextItem(root, item.id);
      let text = source.sourceText;
      if (item.mode === "compressed" && item.compression) {
        const compression = await getContextCompression(root, item.id, item.compression.modelId, item.compression.promptVersion);
        if (compression) text = compression.compressedText;
      }
      content.push(`## ${item.paperTitle}${item.sectionId ? ` / ${item.sectionId}` : ""}\n${text}`);
      snapshotItems.push({ contextItemId: item.id, paperId: item.paperId, sourceHash: item.sourceHash, mode: item.mode, sectionIds: item.sectionId ? [item.sectionId] : [], figureIds: [], estimatedTokens: item.estimatedTokens });
    }
    return {
      contextText: content.join("\n\n"),
      snapshot: {
        id: expected?.id ?? crypto.randomUUID(),
        agentProfileId: "innovation-pipeline",
        modelId: routeModels.ideas,
        items: snapshotItems,
        tokenBreakdown: draft.tokenBreakdown,
        promptVersion: PROMPT_VERSION,
        toolVersions: { find_evidence: "1", get_related_papers: "1" },
        retrievalQueries: [],
        externalResults: [],
        createdAt: expected?.createdAt ?? new Date().toISOString(),
      } satisfies ContextSnapshot,
    };
  };

  const streamStage = async (run: InnovationRun, stage: InnovationStageId, contextText: string, outputs: Partial<Record<InnovationStageId, string>>) => {
    const modelId = run.stageModels[stage];
    const model = customModels.find((item) => item.id === modelId);
    const provider = providers.find((item) => item.id === model?.providerId);
    if (!model || !provider) throw new Error(`${stage} model configuration is unavailable.`);
    if (nativeRuntime && !configuredCredentials.has(provider.credentialId)) throw new Error(`${model.displayName} needs a Stronghold credential.`);
    await startInnovationStage(root, run.id, stage);
    setActiveStage(stage);
    setLiveOutput("");
    setNotice(`${routes.find((route) => route.id === stage)?.label} is streaming.`);
    const started = performance.now();
    let output = "";
    let terminal = false;
    await new Promise<void>((resolve, reject) => {
      const checkpoint = () => {
        if (checkpointTimer.current) window.clearTimeout(checkpointTimer.current);
        checkpointTimer.current = window.setTimeout(() => {
          void updateInnovationStage(root, run.id, stage, { status: "running", outputText: output, durationMs: Math.round(performance.now() - started) });
        }, 750);
      };
      const finish = async (status: "completed" | "failed" | "cancelled", event: ModelStreamEvent) => {
        if (terminal) return;
        terminal = true;
        if (checkpointTimer.current) window.clearTimeout(checkpointTimer.current);
        await updateInnovationStage(root, run.id, stage, {
          status,
          outputText: output,
          inputTokens: event.usage?.inputTokens,
          outputTokens: event.usage?.outputTokens,
          durationMs: Math.round(performance.now() - started),
          error: event.error,
        });
        streamHandle.current?.dispose();
        streamHandle.current = null;
        if (status === "completed") resolve();
        else reject(new Error(status === "cancelled" ? "Pipeline cancelled." : event.error ?? `${stage} failed.`));
      };
      const onEvent = (event: ModelStreamEvent) => {
        if (event.kind === "delta" && event.text) {
          output += event.text;
          setLiveOutput(output);
          checkpoint();
        } else if (event.kind === "done") void finish("completed", event);
        else if (event.kind === "cancelled") void finish("cancelled", event);
        else if (event.kind === "error") void finish("failed", event);
      };
      void startModelStream({
        requestId: `${run.id}:${stage}`,
        provider,
        model,
        temperature: stage === "ideas" ? 0.5 : 0.15,
        messages: [
          { role: "system", content: "你是科研创新流水线中的一个阶段。请默认使用中文，只使用提供的证据，保留来源锚点，绝不虚构搜索、引用、结果或元数据。" },
          { role: "user", content: stageInstruction(stage, run.promptText, contextText, outputs) },
        ],
      }, onEvent).then((handle) => {
        if (terminal) handle.dispose();
        else streamHandle.current = handle;
      }).catch((error) => void finish("failed", { requestId: `${run.id}:${stage}`, kind: "error", error: error instanceof Error ? error.message : String(error) }));
    });
    return output;
  };

  const execute = async (existing?: InnovationRun) => {
    if (!prompt.trim()) throw new Error("Synthesis prompt is required.");
    const assembled = await assembleContext(existing?.contextSnapshot);
    if (!assembled.snapshot.items.length) throw new Error("Add at least one paper to the shared Context before running synthesis.");
    const modelsForRun = existing?.stageModels ?? routeModels;
    for (const route of routes) {
      const model = customModels.find((item) => item.id === modelsForRun[route.id]);
      const provider = providers.find((item) => item.id === model?.providerId);
      if (!model || !provider) throw new Error(`${route.label} model configuration is unavailable.`);
      if (nativeRuntime && !configuredCredentials.has(provider.credentialId)) throw new Error(`${model.displayName} needs a Stronghold credential.`);
    }
    const run = existing ?? await startInnovationRun(root, { promptText: prompt, promptVersion: PROMPT_VERSION, contextSnapshot: assembled.snapshot, stageModels: routeModels });
    setActiveRunId(run.id);
    activeRunRef.current = run.id;
    const outputs = Object.fromEntries(run.stages.filter((stage) => stage.status === "completed").map((stage) => [stage.stage, stage.outputText])) as Partial<Record<InnovationStageId, string>>;
    try {
      for (const route of routes) {
        const stage = run.stages.find((item) => item.stage === route.id);
        if (stage?.status === "completed") continue;
        outputs[route.id] = await streamStage(run, route.id, assembled.contextText, outputs);
      }
      setNotice("Five-stage synthesis completed and persisted.");
    } finally {
      setActiveRunId("");
      activeRunRef.current = "";
      setActiveStage("");
      await refresh();
    }
  };

  const run = async () => {
    if (running) return;
    try {
      await execute();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const cancel = async () => {
    if (!activeRunId) return;
    await streamHandle.current?.cancel();
    await cancelInnovationRun(root, activeRunId).catch(() => undefined);
    setNotice("Pipeline cancellation requested.");
  };

  const retry = async (target: InnovationRun) => {
    if (running) return;
    try {
      await assembleContext(target.contextSnapshot);
      const resumed = await retryInnovationRun(root, target.id);
      setPrompt(resumed.promptText);
      setRouteModels(resumed.stageModels);
      await execute(resumed);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const finalOutput = liveOutput || [...(latestRun?.stages ?? [])].reverse().find((stage) => stage.outputText)?.outputText || "";
  const credentialReady = !nativeRuntime || routes.every((route) => {
    const model = customModels.find((item) => item.id === routeModels[route.id]);
    const provider = providers.find((item) => item.id === model?.providerId);
    return Boolean(provider && configuredCredentials.has(provider.credentialId));
  });

  return <main className="innovation-workspace">
    <header className="innovation-header">
      <div className="innovation-title"><div><h1>Papers2Innovations</h1><span>提示词工作台</span></div><p>在一个绑定来源的共享上下文快照上运行五个可恢复的 AI 阶段。</p></div>
      <div className="innovation-header-actions"><span className="compact-badge">{includedPapers.length} 篇论文</span><span className="compact-badge">{contextPercent}% 上下文</span><button className="secondary-button" onClick={() => setView("settings")}><Settings2 size={14} /> 模型设置</button>{running ? <button className="danger-button" onClick={() => void cancel()}><Square size={14} /> 停止</button> : <button className="primary-button compact" onClick={() => void run()} disabled={!includedPapers.length || !credentialReady}><Sparkles size={14} /> 开始综合</button>}</div>
    </header>

    <div className="innovation-layout">
      <aside className="context-panel">
        <div className="context-panel-heading"><div><strong>共享论文上下文</strong><span>来源模式在阅读器、智能体和创新工作台之间持久化</span></div><button className="icon-button small" title="打开上下文工作区" onClick={() => setView("context")}><Plus size={15} /></button></div>
        <div className="context-meter"><div className="context-meter-label"><span>当前流水线上下文</span><strong>{(contextUsed / 1000).toFixed(1)}K / {Math.round(modelLimit / 1000)}K</strong></div><div className="context-meter-track"><i style={{ width: `${contextPercent}%` }} /></div><div className="context-meter-meta"><span>{context?.items.length ?? 0} 个来源块</span><span>已用 {contextPercent}%</span></div></div>
        <div className="context-paper-list">
          {papers.slice(0, 30).map((paper) => {
            const items = contextItemsByPaper.get(paper.id) ?? [];
            const included = items.length > 0;
            const compressed = items.some((item) => item.mode === "compressed");
            return <section className={`context-paper ${included ? "" : "excluded"}`} key={paper.id}><div className="context-paper-title"><input type="checkbox" checked={included} disabled={busyPaper === paper.id || running} onChange={(event) => void includePaper(paper, event.target.checked)} aria-label={`选择 ${paper.title}`} /><span><strong>{paper.title}</strong><small>{paper.pageCount || "--"} 页 / {included ? `${items.length} 个来源` : "未选择"}</small></span>{compressed && <b>AI</b>}</div>{included ? <div className="context-mode-note"><FileText size={12} /> {compressed ? "AI 压缩后的原文" : "MD 原文或自定义文字"}</div> : <div className="context-excluded">本次运行不包含</div>}</section>;
          })}
          {papers.length === 0 && <div className="context-empty"><FileText size={24} /><span>暂无已解析论文。</span></div>}
        </div>
        <div className="context-panel-footer"><span>精确来源通过哈希绑定</span><button onClick={() => void clearContext(root).then(refresh)} disabled={running}>清空全部</button></div>
      </aside>

      <div className="innovation-main-scroll"><div className="innovation-content">
        <section className="workbench-panel prompt-panel"><div className="workbench-panel-heading"><div><h2>综合提示词</h2><p>修订版保存在本地论文库中，并且只发送到想法生成阶段。</p></div><span className="agent-badge">修订 {promptQuery.data?.revision ?? 0}</span></div><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} spellCheck={false} aria-label="综合提示词" disabled={running} /><div className="prompt-footer"><code>{"{paper_context}"}</code><span>解析为持久化证据台账</span><div><small>{prompt.length} 个字符</small><button onClick={() => setPrompt(defaultPrompt)} disabled={running}><RotateCcw size={12} /> 重置</button><button onClick={() => void savePrompt()} disabled={running}><Save size={12} /> 保存修订</button></div></div></section>

        <section className="workbench-panel model-routing-panel"><div className="workbench-panel-heading"><div><h2>AI 处理阶段</h2><p>流水线失败后恢复时，已完成阶段会继续保留。</p></div>{latestRun && <span className={`agent-badge ${latestRun.status}`}>{stageStatusText(latestRun.status)}</span>}</div><div className="route-list">{routes.map((route) => {
          const status = activeStage === route.id ? "running" : stageStatusLabel(latestRun, route.id);
          return <div className={`route-row innovation-stage-${status}`} key={route.id}><span className="route-number">{status === "completed" ? <CheckCircle2 size={13} /> : status === "running" ? <LoaderCircle className="spin" size={13} /> : status === "failed" || status === "interrupted" ? <TriangleAlert size={13} /> : <Circle size={11} />}</span><span className="route-copy"><strong>{route.label}<b>{stageStatusText(status)}</b></strong><small>{route.description}</small></span><select aria-label={`${route.label} 模型`} value={routeModels[route.id]} disabled={running} onChange={(event) => setRouteModels({ ...routeModels, [route.id]: event.target.value })}>{customModels.map((model) => <option value={model.id} key={model.id}>{model.displayName} / {model.model}</option>)}</select></div>;
        })}</div></section>

        {(finalOutput || latestRun) && <section className="workbench-panel innovation-output-panel"><div className="workbench-panel-heading"><div><h2>{activeStage ? routes.find((route) => route.id === activeStage)?.label : "最近流水线输出"}</h2><p>包含用量和重试状态的持久化阶段输出。</p></div>{latestRun && ["failed", "cancelled", "interrupted"].includes(latestRun.status) && !running && <button className="secondary-button" onClick={() => void retry(latestRun)}><RotateCcw size={13} /> 从 {latestRun.currentStage} 恢复</button>}</div>{finalOutput ? <pre>{finalOutput}</pre> : <p className="context-empty">{latestRun?.error ?? "尚无阶段输出。"}</p>}</section>}

        <div className="innovation-run-bar"><div><strong>{notice}</strong><span>{includedPapers.length} 篇论文 / {(contextUsed / 1000).toFixed(1)}K tokens / {latestRun ? `运行 ${latestRun.id.slice(0, 8)}` : "尚未运行"}</span></div><div><button className="secondary-button" onClick={() => void savePrompt()} disabled={running}><Save size={13} /> 保存模板</button>{running ? <button className="danger-button" onClick={() => void cancel()}><Square size={13} /> 取消</button> : <button className="primary-button compact" onClick={() => void run()} disabled={!includedPapers.length || !credentialReady}><Sparkles size={14} /> 开始综合</button>}</div></div>
      </div></div>
    </div>
  </main>;
}
