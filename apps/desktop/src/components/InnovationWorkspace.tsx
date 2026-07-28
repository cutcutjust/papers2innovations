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
  "Using {paper_context}, identify transferable mechanisms, unresolved limitations, and contradictory assumptions across the selected papers.",
  "",
  "Generate 3 testable research ideas. For each idea provide:",
  "1. Research gap and evidence citations",
  "2. Proposed mechanism and why it may work",
  "3. Falsifiable hypothesis",
  "4. Minimum viable experiment",
  "5. Novelty risks and closest known work",
  "",
  "Do not invent evidence. Cite the paper and page or section for every factual claim.",
].join("\n");

const routes: Array<{ id: InnovationStageId; label: string; description: string }> = [
  { id: "compression", label: "Context compression", description: "Produce an anchor-preserving cross-paper digest" },
  { id: "evidence", label: "Evidence extraction", description: "Extract claims, methods, limitations and citations" },
  { id: "ideas", label: "Idea generation", description: "Generate hypotheses from the editable prompt" },
  { id: "novelty", label: "Novelty verification", description: "Challenge candidates against supplied local evidence" },
  { id: "critique", label: "Critique & experiments", description: "Stress-test claims and design minimum experiments" },
];

function stageInstruction(stage: InnovationStageId, prompt: string, contextText: string, outputs: Partial<Record<InnovationStageId, string>>) {
  if (stage === "compression") return `Compress this research context while preserving every paper/section/page anchor, mechanism, limitation, and uncertainty.\n\n${contextText}`;
  if (stage === "evidence") return `Create a structured evidence ledger. Every entry must include its source anchor. Separate observations, methods, results, limitations, and contradictions.\n\nContext digest:\n${outputs.compression}`;
  if (stage === "ideas") return `${prompt.replace("{paper_context}", outputs.evidence ?? "")}\n\nEvidence ledger:\n${outputs.evidence}`;
  if (stage === "novelty") return `Assess the proposed ideas against the supplied evidence only. Identify closest local work, duplicated mechanisms, weak premises, and claims that require external verification. Do not imply that a web search occurred.\n\nIdeas:\n${outputs.ideas}\n\nEvidence:\n${outputs.evidence}`;
  return `Produce the final research brief. For each surviving idea include grounded premise, falsifiable hypothesis, minimum experiment, confounders, failure criteria, novelty risk, and source anchors. Remove ideas that do not survive critique.\n\nIdeas:\n${outputs.ideas}\n\nNovelty review:\n${outputs.novelty}\n\nEvidence:\n${outputs.evidence}`;
}

function stageStatusLabel(run: InnovationRun | undefined, stage: InnovationStageId) {
  return run?.stages.find((item) => item.stage === stage)?.status ?? "pending";
}

export function InnovationWorkspace({ papers }: { papers: LibraryPaper[] }) {
  const { root, customModels, providers, setView } = useWorkspace();
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [routeModels, setRouteModels] = useState<Record<InnovationStageId, string>>(() => Object.fromEntries(routes.map((route) => [route.id, customModels[0]?.id ?? ""])) as Record<InnovationStageId, string>);
  const [notice, setNotice] = useState("Ready");
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
          { role: "system", content: "You are one stage in a scientific innovation pipeline. Use only supplied evidence, preserve source anchors, and never fabricate searches, citations, results, or metadata." },
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
      <div className="innovation-title"><div><h1>Papers2Innovations</h1><span>Prompt workbench</span></div><p>Five persisted AI stages over one shared, source-bound Context snapshot.</p></div>
      <div className="innovation-header-actions"><span className="compact-badge">{includedPapers.length} papers</span><span className="compact-badge">{contextPercent}% context</span><button className="secondary-button" onClick={() => setView("settings")}><Settings2 size={14} /> Model settings</button>{running ? <button className="danger-button" onClick={() => void cancel()}><Square size={14} /> Stop</button> : <button className="primary-button compact" onClick={() => void run()} disabled={!includedPapers.length || !credentialReady}><Sparkles size={14} /> Run synthesis</button>}</div>
    </header>

    <div className="innovation-layout">
      <aside className="context-panel">
        <div className="context-panel-heading"><div><strong>Shared paper context</strong><span>Source modes persist across Reader, Agents, and Innovate</span></div><button className="icon-button small" title="Open Context workspace" onClick={() => setView("context")}><Plus size={15} /></button></div>
        <div className="context-meter"><div className="context-meter-label"><span>Current pipeline context</span><strong>{(contextUsed / 1000).toFixed(1)}K / {Math.round(modelLimit / 1000)}K</strong></div><div className="context-meter-track"><i style={{ width: `${contextPercent}%` }} /></div><div className="context-meter-meta"><span>{context?.items.length ?? 0} source blocks</span><span>{contextPercent}% used</span></div></div>
        <div className="context-paper-list">
          {papers.slice(0, 30).map((paper) => {
            const items = contextItemsByPaper.get(paper.id) ?? [];
            const included = items.length > 0;
            const compressed = items.some((item) => item.mode === "compressed");
            return <section className={`context-paper ${included ? "" : "excluded"}`} key={paper.id}><div className="context-paper-title"><input type="checkbox" checked={included} disabled={busyPaper === paper.id || running} onChange={(event) => void includePaper(paper, event.target.checked)} aria-label={`Include ${paper.title}`} /><span><strong>{paper.title}</strong><small>{paper.pageCount || "--"} pages / {included ? `${items.length} sources` : "excluded"}</small></span>{compressed && <b>AI</b>}</div>{included ? <div className="context-mode-note"><FileText size={12} /> {compressed ? "Compressed context active" : "Original structured text"}</div> : <div className="context-excluded">Excluded from this run</div>}</section>;
          })}
          {papers.length === 0 && <div className="context-empty"><FileText size={24} /><span>No parsed papers are available.</span></div>}
        </div>
        <div className="context-panel-footer"><span>Exact sources are bound by hash</span><button onClick={() => void clearContext(root).then(refresh)} disabled={running}>Clear all</button></div>
      </aside>

      <div className="innovation-main-scroll"><div className="innovation-content">
        <section className="workbench-panel prompt-panel"><div className="workbench-panel-heading"><div><h2>Synthesis prompt</h2><p>Revisioned in the local library and sent only to the idea stage.</p></div><span className="agent-badge">rev {promptQuery.data?.revision ?? 0}</span></div><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} spellCheck={false} aria-label="Synthesis prompt" disabled={running} /><div className="prompt-footer"><code>{"{paper_context}"}</code><span>Resolves to the persisted evidence ledger</span><div><small>{prompt.length} characters</small><button onClick={() => setPrompt(defaultPrompt)} disabled={running}><RotateCcw size={12} /> Reset</button><button onClick={() => void savePrompt()} disabled={running}><Save size={12} /> Save revision</button></div></div></section>

        <section className="workbench-panel model-routing-panel"><div className="workbench-panel-heading"><div><h2>AI processing stages</h2><p>Completed stages are retained when a failed pipeline resumes.</p></div>{latestRun && <span className={`agent-badge ${latestRun.status}`}>{latestRun.status}</span>}</div><div className="route-list">{routes.map((route, index) => {
          const status = activeStage === route.id ? "running" : stageStatusLabel(latestRun, route.id);
          return <div className={`route-row innovation-stage-${status}`} key={route.id}><span className="route-number">{status === "completed" ? <CheckCircle2 size={13} /> : status === "running" ? <LoaderCircle className="spin" size={13} /> : status === "failed" || status === "interrupted" ? <TriangleAlert size={13} /> : <Circle size={11} />}</span><span className="route-copy"><strong>{route.label}<b>{status}</b></strong><small>{route.description}</small></span><select aria-label={`${route.label} model`} value={routeModels[route.id]} disabled={running} onChange={(event) => setRouteModels({ ...routeModels, [route.id]: event.target.value })}>{customModels.map((model) => <option value={model.id} key={model.id}>{model.displayName} / {model.model}</option>)}</select></div>;
        })}</div></section>

        {(finalOutput || latestRun) && <section className="workbench-panel innovation-output-panel"><div className="workbench-panel-heading"><div><h2>{activeStage ? routes.find((route) => route.id === activeStage)?.label : "Latest pipeline output"}</h2><p>Persisted stage output with usage and retry state.</p></div>{latestRun && ["failed", "cancelled", "interrupted"].includes(latestRun.status) && !running && <button className="secondary-button" onClick={() => void retry(latestRun)}><RotateCcw size={13} /> Resume {latestRun.currentStage}</button>}</div>{finalOutput ? <pre>{finalOutput}</pre> : <p className="context-empty">{latestRun?.error ?? "No stage output yet."}</p>}</section>}

        <div className="innovation-run-bar"><div><strong>{notice}</strong><span>{includedPapers.length} papers / {(contextUsed / 1000).toFixed(1)}K tokens / {latestRun ? `run ${latestRun.id.slice(0, 8)}` : "no run"}</span></div><div><button className="secondary-button" onClick={() => void savePrompt()} disabled={running}><Save size={13} /> Save template</button>{running ? <button className="danger-button" onClick={() => void cancel()}><Square size={13} /> Cancel</button> : <button className="primary-button compact" onClick={() => void run()} disabled={!includedPapers.length || !credentialReady}><Sparkles size={14} /> Run synthesis</button>}</div></div>
      </div></div>
    </div>
  </main>;
}
