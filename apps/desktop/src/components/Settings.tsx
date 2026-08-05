import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  CheckCircle2,
  FileText,
  Image as ImageIcon,
  KeyRound,
  Languages,
  LoaderCircle,
  Pencil,
  Plus,
  ScanText,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Wifi,
  X,
} from "lucide-react";
import type { CredentialSummary, ModelConfig } from "@p2i/contracts";
import {
  deleteProviderCredential,
  hydrateOcrCredential,
  hydrateProviderCredentials,
  synchronizeOcrProvider,
  testProviderConnection,
  testQwenConnection,
} from "../lib/credentials";
import { useWorkspace } from "../store";
import { modelHasCapability } from "../lib/modelCapabilities";
import { ModelSetupPanel, type ModelSetupStatus } from "./ModelSetupPanel";

type SettingsStatus = ModelSetupStatus;
type ConnectionState = "idle" | "testing" | "success" | "error";

const contextLabel = (tokens: number) => tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M` : `${Math.round(tokens / 1000)}K`;

export function Settings() {
  const {
    customModels,
    providers,
    defaultTextModelId,
    translationModelId,
    fullPageOcrModelId,
    visionAnalysisModelId,
    ocrConsent,
    setView,
    removeCustomModel,
    setDefaultTextModelId,
    setTranslationModelId,
    setFullPageOcrModelId,
    setVisionAnalysisModelId,
    setOcrConsent,
  } = useWorkspace();
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [busyAction, setBusyAction] = useState("");
  const [editor, setEditor] = useState<ModelConfig | "new" | null>(null);
  const [providerSummaries, setProviderSummaries] = useState<Record<string, CredentialSummary>>({});
  const [connections, setConnections] = useState<Record<string, ConnectionState>>({});

  const ocrModels = useMemo(
    () => customModels.filter((model) => providers.find((provider) => provider.id === model.providerId)?.format === "openai"),
    [customModels, providers],
  );
  const configuredCount = providers.filter((provider) => providerSummaries[provider.credentialId]?.configured).length;
  const roleReady = (modelId: string) => {
    const model = customModels.find((item) => item.id === modelId);
    const provider = providers.find((item) => item.id === model?.providerId);
    return Boolean(model && provider && providerSummaries[provider.credentialId]?.configured);
  };
  const textReady = roleReady(defaultTextModelId);
  const translationReady = roleReady(translationModelId);
  const visionReady = roleReady(visionAnalysisModelId);

  const run = async (actionId: string, action: () => Promise<void>) => {
    setBusyAction(actionId);
    setStatus(null);
    try {
      await action();
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyAction("");
    }
  };

  useEffect(() => {
    void run("hydrate", async () => {
      const [legacyOcr, summaries] = await Promise.all([
        hydrateOcrCredential(),
        hydrateProviderCredentials(providers),
      ]);
      const summaryMap = Object.fromEntries(summaries.map((item) => [item.credentialId, item]));
      setProviderSummaries(summaryMap);
      const model = customModels.find((item) => item.id === fullPageOcrModelId);
      const provider = providers.find((item) => item.id === model?.providerId);
      if (model && provider && summaryMap[provider.credentialId]?.configured) {
        await synchronizeOcrProvider(provider, model, ocrConsent);
      } else if (legacyOcr.configured) {
        setStatus({ kind: "info", message: "检测到已加密保存的 OCR 凭据，请在下方为 OCR 指定一个模型。" });
      }
    });
    // Registry hydration is intentionally limited to application startup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openNewModel = () => { setEditor("new"); setStatus(null); };

  const openEditModel = (model: ModelConfig) => {
    const provider = providers.find((item) => item.id === model.providerId);
    if (!provider) {
      setStatus({ kind: "error", message: "该模型缺少接口配置。" });
      return;
    }
    setEditor(model);
    setStatus(null);
  };

  const modelSaved = async (model: ModelConfig) => {
    setEditor(null);
    setConnections((current) => ({ ...current, [model.id]: "success" }));
    const summaries = await hydrateProviderCredentials(useWorkspace.getState().providers);
    setProviderSummaries(Object.fromEntries(summaries.map((item) => [item.credentialId, item])));
  };

  const removeModel = (modelId: string) => {
    const model = customModels.find((item) => item.id === modelId);
    if (!model) return;
    if (!window.confirm(`删除 ${model.displayName}？其加密保存的 API Key 也会一并删除。`)) return;
    void run(`remove-${modelId}`, async () => {
      const provider = providers.find((item) => item.id === model.providerId);
      const providerUseCount = customModels.filter((item) => item.providerId === provider?.id).length;
      if (modelId === fullPageOcrModelId) await synchronizeOcrProvider();
      if (provider && providerUseCount <= 1) await deleteProviderCredential(provider.credentialId);
      removeCustomModel(modelId);
      setProviderSummaries((current) => {
        if (!provider) return current;
        const next = { ...current };
        delete next[provider.credentialId];
        return next;
      });
      setStatus({ kind: "success", message: `${model.displayName} 及其加密凭据已删除。` });
    });
  };

  const testModel = (modelId: string) => {
    setConnections((current) => ({ ...current, [modelId]: "testing" }));
    void run(`test-${modelId}`, async () => {
      const model = customModels.find((item) => item.id === modelId);
      const provider = providers.find((item) => item.id === model?.providerId);
      if (!model || !provider) throw new Error("模型接口配置不可用。");
      try {
        const result = await testProviderConnection(provider, model);
        if (!result.ok) throw new Error(`${model.displayName} 返回 HTTP ${result.status}。`);
        setConnections((current) => ({ ...current, [modelId]: "success" }));
        setStatus({ kind: "success", message: `${model.displayName} 连接测试成功。` });
      } catch (error) {
        setConnections((current) => ({ ...current, [modelId]: "error" }));
        throw error;
      }
    });
  };

  const assignOcrModel = (modelId: string) => run("assign-ocr", async () => {
    if (!modelId) {
      await synchronizeOcrProvider();
      setFullPageOcrModelId("");
      setStatus({ kind: "info", message: "全文 OCR 已关闭。" });
      return;
    }
    const model = customModels.find((item) => item.id === modelId);
    const provider = providers.find((item) => item.id === model?.providerId);
    if (!model || !provider) throw new Error("OCR 模型配置不可用。");
    if (!providerSummaries[provider.credentialId]?.configured) throw new Error("请先为该模型保存 API Key，再将其用于 OCR。");
    await synchronizeOcrProvider(provider, model, ocrConsent);
    setFullPageOcrModelId(modelId);
    setStatus({ kind: "success", message: `${model.displayName} 已用于全文 OCR。` });
  });

  const changeOcrConsent = (enabled: boolean) => run("ocr-consent", async () => {
    const model = customModels.find((item) => item.id === fullPageOcrModelId);
    const provider = providers.find((item) => item.id === model?.providerId);
    if (model && provider) await synchronizeOcrProvider(provider, model, enabled);
    setOcrConsent(enabled);
    setStatus({ kind: enabled ? "success" : "info", message: enabled ? "已允许向指定 OCR 模型发送 PDF 渲染页。" : "已禁止上传 PDF 页面。" });
  });

  const testOcr = () => run("test-ocr", async () => {
    const model = customModels.find((item) => item.id === fullPageOcrModelId);
    const provider = providers.find((item) => item.id === model?.providerId);
    if (!model || !provider) throw new Error("请先选择全文 OCR 模型。");
    if (!ocrConsent) throw new Error("测试 OCR 前请先允许上传 PDF 页面。" );
    await synchronizeOcrProvider(provider, model, true);
    const result = await testQwenConnection();
    if (result.requiresWorkspace) throw new Error("此账户需要使用专属业务空间的 Base URL。" );
    if (!result.ok) throw new Error(`${model.displayName} OCR 测试返回 HTTP ${result.status}。`);
    setStatus({ kind: "success", message: `${model.displayName} OCR 连接测试成功。` });
  });

  return <main className="settings-page settings-page-refined">
    <header className="settings-hero">
      <div className="page-title-block"><div className="page-icon"><Bot size={20} /></div><div><h1>模型与处理</h1><p>管理 AI 接口、上下文容量与文档处理流程</p></div></div>
      <div className="settings-hero-actions">
        <button className="secondary-button" onClick={() => setView("security")}><ShieldCheck size={14} /> 安全与应用</button>
        <button className="primary-button compact" onClick={openNewModel}><Plus size={15} /> 添加模型</button>
      </div>
    </header>

    {status && <div className={`settings-status settings-global-status ${status.kind}`} role={status.kind === "error" ? "alert" : "status"}>{status.kind === "error" ? <TriangleAlert size={16} /> : <CheckCircle2 size={16} />}<span>{status.message}</span><button onClick={() => setStatus(null)} title="关闭提示"><X size={14} /></button></div>}

    {editor && <ModelSetupPanel key={editor === "new" ? "new" : editor.id} model={editor === "new" ? undefined : editor} onCancel={() => setEditor(null)} onSaved={(model) => void modelSaved(model)} onStatus={setStatus} />}

    <section className="settings-section model-readiness-section">
      <div className="settings-heading"><div><h2>AI 能力状态</h2><p>至少配置一个文本模型和一个视觉模型；同一个多模态模型可以同时承担两种角色。</p></div><span className={`readiness-total ${textReady && visionReady ? "ready" : "pending"}`}>{Number(textReady) + Number(visionReady)}/2 已就绪</span></div>
      <div className="model-readiness-grid">
        <article className={textReady ? "ready" : "pending"}><span><FileText size={18} /></span><div><strong>文本模型</strong><small>阅读助手、翻译、解释、语法精读和创新推理</small></div><select aria-label="默认文本模型" value={defaultTextModelId} onChange={(event) => setDefaultTextModelId(event.target.value)}><option value="">未配置</option>{customModels.filter((model) => modelHasCapability(model, "text")).map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select><b>{textReady ? "已就绪" : "待配置"}</b></article>
        <article className={visionReady ? "ready" : "pending"}><span><ImageIcon size={18} /></span><div><strong>视觉模型</strong><small>插图解读和质量检查发现的可疑公式修复</small></div><select aria-label="默认视觉模型" value={visionAnalysisModelId} onChange={(event) => setVisionAnalysisModelId(event.target.value)}><option value="">未配置</option>{customModels.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select><b>{visionReady ? "已就绪" : "待配置"}</b></article>
      </div>
    </section>

    <section className="settings-section model-registry-section">
      <div className="settings-heading model-section-heading"><div><h2>模型列表</h2><p>{customModels.length} 个模型 · {configuredCount} 份加密凭据</p></div><span className="vault-badge"><ShieldCheck size={14} /> Stronghold</span></div>
      <div className="model-registry refined">
        {!customModels.length && <button className="model-registry-empty" onClick={openNewModel}><Plus size={20} /><strong>添加第一个模型</strong><span>支持 OpenAI-compatible 与 Anthropic-compatible 接口</span></button>}
        {customModels.map((model) => {
          const provider = providers.find((item) => item.id === model.providerId);
          const configured = Boolean(provider && providerSummaries[provider.credentialId]?.configured);
          const connection = connections[model.id] ?? "idle";
          const roles = [model.id === defaultTextModelId ? "文本" : "", model.id === translationModelId ? "翻译" : "", model.id === visionAnalysisModelId ? "视觉" : "", model.id === fullPageOcrModelId ? "OCR" : ""].filter(Boolean);
          return <article className="model-registry-row refined" key={model.id}>
            <span className={`model-health ${configured ? "ready" : "missing"}`} />
            <span className="model-format-badge">{provider?.format === "anthropic" ? "Anthropic" : "OpenAI"}</span>
            <span className="model-registry-copy"><span><strong>{model.displayName}</strong>{roles.map((role) => <em key={role}>{role}</em>)}</span><small>{model.model}</small><small className="model-endpoint" title={provider?.baseUrl}>{provider?.baseUrl ?? "缺少接口配置"}</small></span>
            <span className="model-context-summary"><strong>{contextLabel(model.maxContextTokens)}</strong><small>上下文</small></span>
            <span className={`credential-state ${configured ? "ready" : "missing"} ${connection}`}>
              {connection === "testing" ? <LoaderCircle className="spin" size={13} /> : connection === "error" ? <TriangleAlert size={13} /> : configured ? <KeyRound size={13} /> : <TriangleAlert size={13} />}
              {connection === "testing" ? "测试中" : connection === "success" ? "连接成功" : connection === "error" ? "连接失败" : configured ? "已加密" : "缺少密钥"}
            </span>
            <div className="model-row-actions"><button className="icon-button small" onClick={() => testModel(model.id)} title={`测试 ${model.displayName}`} disabled={!configured || Boolean(busyAction)}><Wifi size={14} /></button><button className="icon-button small" onClick={() => openEditModel(model)} title={`编辑 ${model.displayName}`}><Pencil size={14} /></button><button className="icon-button small danger-icon" onClick={() => removeModel(model.id)} title={`删除 ${model.displayName}`} disabled={Boolean(busyAction)}><Trash2 size={14} /></button></div>
          </article>;
        })}
      </div>
    </section>

    <section className="settings-section workflow-settings-section">
      <div className="settings-heading"><div><h2>文档处理</h2><p>为处理任务指定已配置的模型，无需重复保存密钥。</p></div><Bot size={18} /></div>
      <div className="workflow-row"><span className="workflow-icon markdown"><Languages size={17} /></span><span className="workflow-copy"><strong>论文翻译</strong><small>建议选择直接输出、非深度推理的文本模型；失败句可以单独重试</small></span><select aria-label="论文翻译模型" value={translationModelId} onChange={(event) => setTranslationModelId(event.target.value)}><option value="">继承默认文本模型</option>{customModels.filter((model) => modelHasCapability(model, "text")).map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select><span className={`workflow-state ${translationReady ? "ready" : "off"}`}>{translationReady ? "已就绪" : "待配置"}</span></div>
      <div className="workflow-row"><span className="workflow-icon ocr"><ScanText size={17} /></span><span className="workflow-copy"><strong>全文 OCR</strong><small>使用 OpenAI 兼容的视觉模型识别渲染页面</small></span><select aria-label="全文 OCR 模型" value={fullPageOcrModelId} onChange={(event) => void assignOcrModel(event.target.value)} disabled={busyAction === "assign-ocr"}><option value="">关闭</option>{ocrModels.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select><button className="icon-button" onClick={() => void testOcr()} title="测试全文 OCR" disabled={!fullPageOcrModelId || !ocrConsent || Boolean(busyAction)}>{busyAction === "test-ocr" ? <LoaderCircle className="spin" size={15} /> : <Wifi size={15} />}</button></div>
      <div className="workflow-row"><span className="workflow-icon vision"><ImageIcon size={17} /></span><span className="workflow-copy"><strong>导入期视觉重建</strong><small>逐页生成 Markdown，并自动处理章节、换行、插图、表格和可疑公式</small></span><select aria-label="视觉重建模型" value={visionAnalysisModelId} onChange={(event) => setVisionAnalysisModelId(event.target.value)}><option value="">未配置</option>{customModels.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select><span className={`workflow-state ${visionAnalysisModelId ? "ready" : "off"}`}>{visionAnalysisModelId ? "导入时确认" : "关闭"}</span></div>
      <div className="ocr-consent-row"><ShieldCheck size={16} /><span><strong>发送 PDF 页面</strong><small>渲染页会在本地缓存，只有启用后才会发送给所选模型。</small></span><label className="compact-switch"><input type="checkbox" checked={ocrConsent} onChange={(event) => void changeOcrConsent(event.target.checked)} disabled={Boolean(busyAction)} /><span /></label></div>
    </section>

  </main>;
}
