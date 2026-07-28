import type { AgentProfile, AgentRun, ContextSnapshot, ModelMessage, ModelStreamEvent, ModelToolCall } from "@p2i/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  CheckCircle2,
  Database,
  History,
  KeyRound,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Save,
  Search,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  cancelAgentRun,
  deleteAgentProfile,
  executeAgentTool,
  getContextCompression,
  getContextDraft,
  listAgentProfiles,
  listAgentRuns,
  listAgentTools,
  nativeRuntime,
  readContextItem,
  retryAgentRun,
  startAgentRun,
  startModelStream,
  updateAgentRun,
  upsertAgentProfile,
  type ModelStreamHandle,
} from "../lib/bridge";
import { hydrateProviderCredentials } from "../lib/credentials";
import { useWorkspace } from "../store";

const AVAILABLE_TOOLS = [
  ["search_library", "搜索本地论文库"],
  ["read_paper", "读取结构化论文"],
  ["read_section", "读取论文章节"],
  ["read_figure", "读取插图及说明"],
  ["find_evidence", "解析证据锚点"],
  ["get_references", "读取引用图谱"],
  ["get_related_papers", "查找相关本地论文"],
  ["count_context_tokens", "计算上下文 token"],
  ["create_note", "保存研究笔记"],
  ["update_context", "更新共享上下文"],
] as const;

type EditableProfile = Omit<AgentProfile, "latestRun">;

function statusLabel(profile: AgentProfile, credentialConfigured: boolean) {
  if (!credentialConfigured) return "缺少密钥";
  if (!profile.enabled) return "已停用";
  if (profile.latestRun?.status === "running") return "运行中";
  if (profile.latestRun?.status === "failed" || profile.latestRun?.status === "interrupted") return "需要处理";
  return profile.latestRun ? "就绪" : "空闲";
}

function statusClass(status: string) {
  if (status === "运行中") return "tag-ai";
  if (["缺少密钥", "需要处理"].includes(status)) return "tag-warning";
  if (status === "已停用") return "";
  return "tag-success";
}

function blankProfile(modelId: string, providerId: string, credentialId: string): EditableProfile {
  const now = new Date().toISOString();
  const id = `agent-${crypto.randomUUID()}`;
  return {
    id,
    name: "新建研究智能体",
    description: "面向当前研究上下文的专用助手。",
    color: "#4f6bed",
    enabled: true,
    providerId,
    modelId,
    credentialId,
    maxContextTokens: 128000,
    maxOutputTokens: 4096,
    contextSafetyRatio: 0.85,
    temperature: 0.2,
    timeoutSeconds: 90,
    maxRetries: 2,
    allowedTools: ["read_paper", "read_section", "find_evidence"],
    networkPolicy: "none",
    writePolicy: "confirm-write",
    systemPromptId: `system:${id}`,
    systemPrompt: "请默认使用中文，根据提供的研究上下文回答。所有事实性陈述都要引用证据锚点；证据不足时必须明确说明，不得编造。",
    promptVersion: "agent-v1",
    createdAt: now,
    updatedAt: now,
  };
}

function runStatusCopy(run?: AgentRun) {
  if (!run) return "尚未运行";
  if (run.status === "completed") return "已完成";
  if (run.status === "running") return "生成中";
  if (run.status === "cancelled") return "已取消";
  if (run.status === "interrupted") return "重启后中断";
  return "失败";
}

export function Agents() {
  const { root, customModels, providers, setView } = useWorkspace();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EditableProfile | null>(null);
  const [task, setTask] = useState("请分析当前研究上下文，给出最重要且有证据支持的结论。" );
  const [activeRunId, setActiveRunId] = useState("");
  const [liveOutput, setLiveOutput] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [profileSearch, setProfileSearch] = useState("");
  const [activeTab, setActiveTab] = useState<"run" | "config" | "history">("run");
  const streamHandle = useRef<ModelStreamHandle | null>(null);
  const checkpointTimer = useRef<number | null>(null);
  const activeRunIdRef = useRef("");

  const profilesQuery = useQuery({
    queryKey: ["agent-profiles", root],
    queryFn: () => listAgentProfiles(root),
    enabled: Boolean(root),
    retry: false,
  });
  const credentialsQuery = useQuery({
    queryKey: ["provider-credentials", providers.map((provider) => provider.credentialId).sort().join(":")],
    queryFn: () => hydrateProviderCredentials(providers),
    retry: false,
  });
  const contextQuery = useQuery({
    queryKey: ["context-draft", root],
    queryFn: () => getContextDraft(root),
    enabled: Boolean(root),
    retry: false,
  });
  const profiles = profilesQuery.data ?? [];
  const selected = profiles.find((profile) => profile.id === selectedId) ?? profiles[0];
  const runsQuery = useQuery({
    queryKey: ["agent-runs", root, selected?.id],
    queryFn: () => listAgentRuns(root, selected!.id),
    enabled: Boolean(root && selected?.id),
    retry: false,
    refetchInterval: activeRunId ? 2000 : false,
  });
  const runs = runsQuery.data ?? [];
  const visibleProfiles = useMemo(() => {
    const needle = profileSearch.trim().toLowerCase();
    return needle ? profiles.filter((profile) => `${profile.name} ${profile.description}`.toLowerCase().includes(needle)) : profiles;
  }, [profileSearch, profiles]);
  const configuredCredentials = useMemo(
    () => new Set((credentialsQuery.data ?? []).filter((item) => item.configured).map((item) => item.credentialId)),
    [credentialsQuery.data],
  );

  useEffect(() => {
    if (!selectedId && profiles[0]) setSelectedId(profiles[0].id);
    if (selectedId && profiles.length > 0 && !profiles.some((profile) => profile.id === selectedId)) setSelectedId(profiles[0].id);
  }, [profiles, selectedId]);

  useEffect(() => () => {
    if (streamHandle.current) {
      void streamHandle.current.cancel();
      streamHandle.current.dispose();
    }
    if (activeRunIdRef.current) void cancelAgentRun(root, activeRunIdRef.current).catch(() => undefined);
    if (checkpointTimer.current) window.clearTimeout(checkpointTimer.current);
  }, [root]);

  const selectedModel = customModels.find((model) => model.id === selected?.modelId) ?? customModels[0];
  const selectedProvider = providers.find((provider) => provider.id === selectedModel?.providerId);
  const selectedConfigured = !nativeRuntime || Boolean(selectedProvider && configuredCredentials.has(selectedProvider.credentialId));
  const running = Boolean(activeRunId || runs.some((run) => run.status === "running"));

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["agent-profiles", root] }),
      queryClient.invalidateQueries({ queryKey: ["agent-runs", root] }),
    ]);
  };

  const beginEdit = (profile?: AgentProfile) => {
    if (profile) {
      const { latestRun: _latestRun, ...editable } = profile;
      setDraft(editable);
    } else {
      const model = customModels[0];
      const provider = providers.find((item) => item.id === model?.providerId);
      setDraft(blankProfile(model?.id ?? "", provider?.id ?? "", provider?.credentialId ?? ""));
    }
    setEditing(true);
    setActiveTab("config");
    setNotice("");
  };

  const saveProfile = async () => {
    if (!draft) return;
    const model = customModels.find((item) => item.id === draft.modelId);
    const provider = providers.find((item) => item.id === model?.providerId);
    if (!model || !provider) {
      setNotice("请先选择一个已配置的自定义模型，再保存智能体。");
      return;
    }
    setBusy(true);
    try {
      const saved = await upsertAgentProfile(root, {
        ...draft,
        providerId: provider.id,
        credentialId: provider.credentialId,
        maxContextTokens: model.maxContextTokens,
        maxOutputTokens: Math.min(draft.maxOutputTokens, model.maxOutputTokens),
      });
      await invalidate();
      setSelectedId(saved.id);
      setEditing(false);
      setActiveTab("run");
      setNotice("智能体配置已保存到当前论文库。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const removeProfile = async () => {
    if (!selected || !window.confirm(`删除智能体“${selected.name}”？如果已有运行历史，建议改为停用。`)) return;
    setBusy(true);
    try {
      await deleteAgentProfile(root, selected.id);
      setSelectedId("");
      setNotice("智能体配置已删除。");
      await invalidate();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const assembleContext = async (profile: AgentProfile, expected?: ContextSnapshot) => {
    const context = await getContextDraft(root);
    const expectedItems = new Map((expected?.items ?? []).map((item) => [item.contextItemId, item]));
    const selectedItems = expected
      ? context.items.filter((item) => expectedItems.has(item.id))
      : context.items;
    const content: string[] = [];
    const snapshotItems: ContextSnapshot["items"] = [];
    for (const item of selectedItems) {
      const expectedItem = expectedItems.get(item.id);
      if (expectedItem?.sourceHash && expectedItem.sourceHash !== item.sourceHash) {
        throw new Error(`Context source changed for ${item.paperTitle}; create a new run instead of retrying.`);
      }
      const source = await readContextItem(root, item.id);
      let text = source.sourceText;
      if (item.mode === "compressed" && item.compression) {
        const compression = await getContextCompression(root, item.id, item.compression.modelId, item.compression.promptVersion);
        if (compression) text = compression.compressedText;
      }
      content.push(`## ${item.paperTitle}${item.sectionId ? ` / ${item.sectionId}` : ""}\n${text}`);
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
    const estimated = Object.values(context.tokenBreakdown).reduce((total, value) => total + value, 0);
    if (estimated > profile.maxContextTokens * profile.contextSafetyRatio) {
      throw new Error("Shared context exceeds this agent's safety limit. Remove sources or choose a larger model.");
    }
    const snapshot: ContextSnapshot = {
      id: expected?.id ?? crypto.randomUUID(),
      agentProfileId: profile.id,
      modelId: profile.modelId,
      reasoningEffort: profile.reasoningEffort,
      items: snapshotItems,
      tokenBreakdown: context.tokenBreakdown,
      promptVersion: profile.promptVersion,
      toolVersions: Object.fromEntries(profile.allowedTools.map((tool) => [tool, "1"])),
      retrievalQueries: [],
      externalResults: [],
      createdAt: expected?.createdAt ?? new Date().toISOString(),
    };
    return { snapshot, contextText: content.length ? content.join("\n\n") : "No paper context is currently selected." };
  };

  const execute = async (profile: AgentProfile, existingRun?: AgentRun) => {
    const model = customModels.find((item) => item.id === profile.modelId);
    const provider = providers.find((item) => item.id === model?.providerId);
    if (!model || !provider) throw new Error("The agent's model configuration is unavailable.");
    if (nativeRuntime && !configuredCredentials.has(provider.credentialId)) throw new Error("This model needs a Stronghold credential.");
    const prompt = existingRun?.userPrompt ?? task.trim();
    if (!prompt) throw new Error("Enter a task for the agent.");
    let assembled: Awaited<ReturnType<typeof assembleContext>>;
    try {
      assembled = await assembleContext(profile, existingRun?.contextSnapshot);
    } catch (error) {
      if (existingRun) {
        await updateAgentRun(root, existingRun.id, {
          status: "failed",
          outputText: existingRun.outputText,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
      }
      throw error;
    }
    const run = existingRun ?? await startAgentRun(root, {
      agentProfileId: profile.id,
      userPrompt: prompt,
      contextSnapshot: assembled.snapshot,
    });
    const tools = await listAgentTools(root, profile.id);
    const started = performance.now();
    let output = "";
    let terminal = false;
    let inputTokens = 0;
    let outputTokens = 0;
    const messages: ModelMessage[] = [
      { role: "system", content: profile.systemPrompt },
      { role: "user", content: `Task:\n${prompt}\n\nResearch context:\n${assembled.contextText}` },
    ];
    setActiveRunId(run.id);
    activeRunIdRef.current = run.id;
    setLiveOutput("");
    setNotice("Agent stream started.");

    const checkpoint = () => {
      if (checkpointTimer.current) window.clearTimeout(checkpointTimer.current);
      checkpointTimer.current = window.setTimeout(() => {
        void updateAgentRun(root, run.id, { status: "running", outputText: output, durationMs: Math.round(performance.now() - started) });
      }, 750);
    };
    const finish = async (status: "completed" | "failed" | "cancelled", event?: ModelStreamEvent) => {
      if (terminal) return;
      terminal = true;
      if (checkpointTimer.current) window.clearTimeout(checkpointTimer.current);
      await updateAgentRun(root, run.id, {
        status,
        outputText: output,
        inputTokens,
        outputTokens,
        durationMs: Math.round(performance.now() - started),
        error: event?.error,
      });
      streamHandle.current?.dispose();
      streamHandle.current = null;
      setActiveRunId("");
      activeRunIdRef.current = "";
      setNotice(status === "completed" ? "Agent run completed and persisted." : status === "cancelled" ? "Agent run cancelled." : event?.error ?? "Agent run failed.");
      await invalidate();
    };
    const runRound = async (iteration: number): Promise<void> => {
      if (terminal || activeRunIdRef.current !== run.id) return;
      let roundText = "";
      let roundTerminal = false;
      const requestId = `${run.id}:round:${iteration}`;
      const accountUsage = (event: ModelStreamEvent) => {
        inputTokens += event.usage?.inputTokens ?? 0;
        outputTokens += event.usage?.outputTokens ?? 0;
      };
      const handleToolCalls = async (calls: ModelToolCall[], event: ModelStreamEvent) => {
        accountUsage(event);
        if (!calls.length) {
          await finish("failed", { ...event, kind: "error", error: "Provider returned an empty tool call batch." });
          return;
        }
        if (iteration >= 6) {
          await finish("failed", { ...event, kind: "error", error: "Agent tool loop exceeded the six-round safety limit." });
          return;
        }
        messages.push({ role: "assistant", content: roundText, toolCalls: calls });
        try {
          for (const call of calls.slice(0, 8)) {
            if (activeRunIdRef.current !== run.id) {
              terminal = true;
              return;
            }
            const record = await executeAgentTool(root, {
              runId: run.id,
              toolCallId: call.id,
              toolName: call.name,
              arguments: call.arguments,
              iteration,
            });
            messages.push({
              role: "tool",
              toolCallId: call.id,
              content: JSON.stringify({ status: record.status, result: record.result, error: record.error }),
            });
          }
          if (activeRunIdRef.current !== run.id) {
            terminal = true;
            return;
          }
          await invalidate();
          setNotice(`Completed ${calls.length} tool call${calls.length === 1 ? "" : "s"}; continuing model round ${iteration + 1}.`);
          await runRound(iteration + 1);
        } catch (error) {
          await finish("failed", { requestId, kind: "error", error: error instanceof Error ? error.message : String(error) });
        }
      };
      const onEvent = (event: ModelStreamEvent) => {
        if (event.kind === "delta" && event.text) {
          roundText += event.text;
          output += event.text;
          setLiveOutput(output);
          checkpoint();
        } else if (event.kind === "tool_calls") {
          roundTerminal = true;
          streamHandle.current?.dispose();
          streamHandle.current = null;
          void handleToolCalls(event.toolCalls ?? [], event);
        } else if (event.kind === "done") {
          roundTerminal = true;
          accountUsage(event);
          void finish("completed", event);
        } else if (event.kind === "cancelled") {
          roundTerminal = true;
          accountUsage(event);
          void finish("cancelled", event);
        } else if (event.kind === "error") {
          roundTerminal = true;
          void finish("failed", event);
        }
      };
      try {
        const handle = await startModelStream({ requestId, provider, model, temperature: profile.temperature, messages, tools }, onEvent);
        if (roundTerminal || terminal) handle.dispose();
        else streamHandle.current = handle;
      } catch (error) {
        await finish("failed", { requestId, kind: "error", error: error instanceof Error ? error.message : String(error) });
      }
    };
    await runRound(1);
  };

  const start = async () => {
    if (!selected || busy || running) return;
    setBusy(true);
    try {
      await execute(selected);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!activeRunId) return;
    await streamHandle.current?.cancel();
    await cancelAgentRun(root, activeRunId).catch(() => undefined);
    streamHandle.current?.dispose();
    streamHandle.current = null;
    setActiveRunId("");
    activeRunIdRef.current = "";
    await invalidate();
  };

  const retry = async (run: AgentRun) => {
    if (!selected || running) return;
    setBusy(true);
    try {
      const retried = await retryAgentRun(root, run.id);
      await execute(selected, retried);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (profilesQuery.isLoading) return <div className="agents-page agent-loading"><LoaderCircle className="spin" size={20} /> 正在加载本地智能体运行时...</div>;
  if (profilesQuery.isError) return <div className="agents-page agent-loading"><TriangleAlert size={20} /> {profilesQuery.error instanceof Error ? profilesQuery.error.message : "智能体运行时加载失败。"}</div>;

  const contextItems = contextQuery.data?.items.length ?? 0;
  const contextTokens = contextQuery.data ? Object.values(contextQuery.data.tokenBreakdown).reduce((sum, value) => sum + value, 0) : 0;
  return <div className="agents-page agent-center-refined">
    <header className="agent-center-hero">
      <div><span className="agent-hero-mark"><Sparkles size={20} /></span><span><h1>智能体中心</h1><p>把论文上下文交给可配置、可追溯的研究智能体</p></span></div>
      <div className="page-actions"><button className="secondary-button" onClick={() => setView("settings")}><Settings2 size={13} /> 模型设置</button><button className="primary-button compact" onClick={() => beginEdit()}><Plus size={13} /> 新建智能体</button></div>
    </header>
    <section className="agent-health-strip"><div><Bot size={16} /><span><small>智能体</small><strong>{profiles.length}</strong></span></div><div><Database size={16} /><span><small>共享上下文</small><strong>{contextItems} 项 · {(contextTokens / 1000).toFixed(1)}K</strong></span></div><div><Wrench size={16} /><span><small>可用模型</small><strong>{customModels.length}</strong></span></div><div><History size={16} /><span><small>当前状态</small><strong>{running ? "正在运行" : "本地就绪"}</strong></span></div></section>
    <div className="agent-center-body">
      <aside className="agent-catalog">
        <header><div><strong>研究智能体</strong><small>选择一个智能体开始任务</small></div><button title="新建智能体" onClick={() => beginEdit()}><Plus size={14} /></button></header>
        <label className="agent-search"><Search size={13} /><input value={profileSearch} onChange={(event) => setProfileSearch(event.target.value)} placeholder="搜索智能体" /></label>
        <div className="agent-catalog-list">{visibleProfiles.map((profile) => {
          const model = customModels.find((item) => item.id === profile.modelId);
          const provider = providers.find((item) => item.id === model?.providerId);
          const configured = !nativeRuntime || Boolean(provider && configuredCredentials.has(provider.credentialId));
          const status = statusLabel(profile, configured);
          return <button key={profile.id} className={`agent-catalog-item ${selected?.id === profile.id && !editing ? "selected" : ""}`} onClick={() => { setSelectedId(profile.id); setEditing(false); setActiveTab("run"); setNotice(""); }}><span className="agent-icon" style={{ color: profile.color, background: `${profile.color}14`, borderColor: `${profile.color}55` }}><Bot size={17} /></span><span><strong>{profile.name}</strong><small>{model?.displayName ?? profile.modelId}</small></span><em className={statusClass(status)}>{status}</em></button>;
        })}{visibleProfiles.length === 0 && <div className="agent-catalog-empty"><Bot size={22} /><span>没有匹配的智能体</span></div>}</div>
      </aside>

      <main className="agent-workbench">{editing && draft ? <>
        <header className="agent-workbench-header"><span className="agent-icon" style={{ color: draft.color, background: `${draft.color}14`, borderColor: `${draft.color}55` }}><Pencil size={18} /></span><div><h2>{profiles.some((profile) => profile.id === draft.id) ? "编辑智能体" : "创建研究智能体"}</h2><p>配置模型、权限与回答边界，保存后即可运行</p></div></header>
        <div className="agent-config-layout"><section className="agent-config-main"><div className="agent-profile-form refined"><label><span>名称</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：方法复现助手" /></label><label><span>说明</span><input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="一句话说明它擅长什么" /></label><label><span>运行模型</span><select value={draft.modelId} onChange={(event) => setDraft({ ...draft, modelId: event.target.value })}>{customModels.map((model) => <option value={model.id} key={model.id}>{model.displayName} · {model.model}</option>)}</select></label><div className="agent-profile-policies"><label><span>联网范围</span><select value={draft.networkPolicy} onChange={(event) => setDraft({ ...draft, networkPolicy: event.target.value as AgentProfile["networkPolicy"] })}><option value="none">仅本地</option><option value="academic">仅学术来源</option><option value="full">允许公开网络</option></select></label><label><span>写入策略</span><select value={draft.writePolicy} onChange={(event) => setDraft({ ...draft, writePolicy: event.target.value as AgentProfile["writePolicy"] })}><option value="read-only">只读</option><option value="confirm-write">写入前确认</option><option value="trusted-write">允许可信写入</option></select></label></div><label><span>系统提示词</span><textarea value={draft.systemPrompt} onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })} /></label><label className="agent-enabled"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /><span>保存后立即启用</span></label></div></section><aside className="agent-tool-picker"><header><Wrench size={15} /><span><strong>工具权限</strong><small>仅开启任务确实需要的能力</small></span></header>{AVAILABLE_TOOLS.map(([id, label]) => <label key={id}><input type="checkbox" checked={draft.allowedTools.includes(id)} onChange={(event) => setDraft({ ...draft, allowedTools: event.target.checked ? [...draft.allowedTools, id] : draft.allowedTools.filter((tool) => tool !== id) })} /><span>{label}</span></label>)}</aside></div>
        <footer className="agent-config-actions"><button className="secondary-button" onClick={() => { setEditing(false); setActiveTab("run"); }}>取消</button><button className="primary-button compact" onClick={() => void saveProfile()} disabled={busy || !draft.name.trim()}>{busy ? <LoaderCircle className="spin" size={13} /> : <Save size={13} />} 保存智能体</button></footer>
      </> : selected ? <>
        <header className="agent-workbench-header"><span className="agent-icon large" style={{ color: selected.color, background: `${selected.color}14`, borderColor: `${selected.color}55` }}><Sparkles size={20} /></span><div><h2>{selected.name}</h2><p>{selected.description}</p></div><span className={`tag ${statusClass(statusLabel(selected, selectedConfigured))}`}>{statusLabel(selected, selectedConfigured)}</span></header>
        <nav className="agent-workbench-tabs"><button className={activeTab === "run" ? "active" : ""} onClick={() => setActiveTab("run")}><Play size={12} /> 运行</button><button className={activeTab === "config" ? "active" : ""} onClick={() => setActiveTab("config")}><Settings2 size={12} /> 配置概览</button><button className={activeTab === "history" ? "active" : ""} onClick={() => setActiveTab("history")}><History size={12} /> 历史 {runs.length > 0 && <b>{runs.length}</b>}</button></nav>
        {activeTab === "run" && <div className="agent-run-workspace"><section className="agent-readiness"><div className={contextItems ? "ready" : "warning"}><Database size={16} /><span><strong>{contextItems ? "上下文已准备" : "尚未加入论文上下文"}</strong><small>{contextItems ? `${contextItems} 项来源，约 ${(contextTokens / 1000).toFixed(1)}K tokens` : "先从阅读器或上下文工作区加入 MD 原文、AI 压缩原文或自定义文字"}</small></span><button onClick={() => setView("context")}>管理上下文</button></div><div><Wrench size={16} /><span><strong>{selected.allowedTools.length} 个工具可用</strong><small>{selectedModel?.displayName ?? selected.modelId} · {Math.round(selected.maxContextTokens / 1000)}K 上下文</small></span></div></section><section className="agent-task-composer"><header><span><strong>交给智能体一个明确任务</strong><small>结果、调用记录和 token 用量会保存到当前论文库</small></span></header><textarea value={task} onChange={(event) => setTask(event.target.value)} aria-label="智能体任务" disabled={running} placeholder="例如：比较上下文中三篇论文的方法差异，并提出两个可验证的研究空白。" />{liveOutput && <div className="agent-live-output"><span><LoaderCircle className="spin" size={12} /> 实时输出</span><pre>{liveOutput}</pre></div>}<footer>{!selectedConfigured ? <button className="primary-button compact" onClick={() => setView("settings")}><KeyRound size={13} /> 配置模型密钥</button> : running ? <button className="danger-button" onClick={() => void cancel()}><Square size={13} /> 停止运行</button> : <button className="primary-button compact" onClick={() => void start()} disabled={busy || !selected.enabled || !task.trim()}>{busy ? <LoaderCircle className="spin" size={13} /> : <Play size={13} />} 开始运行</button>}</footer></section></div>}
        {activeTab === "config" && <div className="agent-overview-grid"><section><h3>运行参数</h3><dl><div><dt>模型</dt><dd>{selectedModel?.displayName ?? selected.modelId}</dd></div><div><dt>上下文上限</dt><dd>{Math.round(selected.maxContextTokens / 1000)}K</dd></div><div><dt>联网范围</dt><dd>{selected.networkPolicy === "none" ? "仅本地" : selected.networkPolicy === "academic" ? "学术来源" : "公开网络"}</dd></div><div><dt>写入策略</dt><dd>{selected.writePolicy === "read-only" ? "只读" : selected.writePolicy === "confirm-write" ? "写入前确认" : "可信写入"}</dd></div></dl></section><section><h3>已启用工具</h3><div className="agent-tool-summary">{selected.allowedTools.map((tool) => <span key={tool}><CheckCircle2 size={12} /> {AVAILABLE_TOOLS.find(([id]) => id === tool)?.[1] ?? tool}</span>)}</div></section><footer><button className="secondary-button" onClick={() => beginEdit(selected)} disabled={running}><Pencil size={13} /> 编辑配置</button><button className="danger-link" onClick={() => void removeProfile()} disabled={running || busy}><Trash2 size={13} /> 删除智能体</button></footer></div>}
        {activeTab === "history" && <div className="agent-history-panel">{runs.length === 0 ? <div className="agent-history-empty"><History size={25} /><strong>还没有运行记录</strong><span>完成一次任务后，这里会保留结果、工具调用和 token 用量。</span><button className="secondary-button" onClick={() => setActiveTab("run")}>创建第一次运行</button></div> : runs.map((run) => <article key={run.id} className={`agent-run-row ${run.status}`}><header><span><strong>{runStatusCopy(run)}</strong><small>{new Date(run.createdAt).toLocaleString("zh-CN")}</small></span><code>{run.usage.inputTokens + run.usage.outputTokens} tokens · {(run.usage.durationMs / 1000).toFixed(1)} 秒</code></header><h4>{run.userPrompt}</h4><p>{run.outputText || run.error || "尚无输出"}</p>{run.toolCalls.length > 0 && <div className="agent-run-tools">{run.toolCalls.map((call) => <span className={call.status} key={call.id}><Sparkles size={9} /> {call.toolName}<b>{call.status}</b></span>)}</div>}<footer><span>{run.toolCalls.length} 次工具调用</span>{["failed", "cancelled", "interrupted"].includes(run.status) && <button title="重试运行" onClick={() => void retry(run)} disabled={running || busy}><RotateCcw size={12} /> 重试</button>}</footer></article>)}</div>}
      </> : <div className="agent-welcome-empty"><Bot size={32} /><h2>创建第一个研究智能体</h2><p>选择模型、设定工具权限，然后让它基于你的论文上下文执行可追溯任务。</p><button className="primary-button compact" onClick={() => beginEdit()}><Plus size={13} /> 新建智能体</button></div>}
      {notice && <div className="agent-runtime-notice">{notice}</div>}
      </main>
    </div>
  </div>;
}
