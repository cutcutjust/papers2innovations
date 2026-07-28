import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Check,
  CheckCircle2,
  Eye,
  EyeOff,
  FileText,
  Image as ImageIcon,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  ScanText,
  Server,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Wifi,
  X,
} from "lucide-react";
import type { CredentialSummary, ModelConfig, ProviderConfig } from "@p2i/contracts";
import {
  clearOcrProvider,
  configureOcrProvider,
  deleteProviderCredential,
  hydrateOcrCredential,
  hydrateProviderCredentials,
  saveProviderCredential,
  testProviderConnection,
  testQwenConnection,
} from "../lib/credentials";
import { providerIdForModel } from "../lib/providerConfig";
import { useWorkspace, type ModelApiFormat } from "../store";

type ContextMode = "128000" | "256000" | "1000000" | "custom";
type SettingsStatus = { kind: "success" | "error" | "info"; message: string };
type ConnectionState = "idle" | "testing" | "success" | "error";

interface ModelDraft {
  originalId?: string;
  displayName: string;
  modelId: string;
  baseUrl: string;
  format: ModelApiFormat;
  apiKey: string;
  maxContextTokens: number;
  useForMarkdown: boolean;
  useForOcr: boolean;
}

const emptyDraft = (): ModelDraft => ({
  displayName: "",
  modelId: "",
  baseUrl: "",
  format: "openai",
  apiKey: "",
  maxContextTokens: 128000,
  useForMarkdown: false,
  useForOcr: false,
});

const contextLabel = (tokens: number) => tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M` : `${Math.round(tokens / 1000)}K`;

export function Settings() {
  const {
    customModels,
    providers,
    markdownFormattingModelId,
    autoFormatMarkdown,
    fullPageOcrModelId,
    visionAnalysisModelId,
    ocrConsent,
    setView,
    addCustomModel,
    removeCustomModel,
    setMarkdownFormattingModelId,
    setAutoFormatMarkdown,
    setFullPageOcrModelId,
    setVisionAnalysisModelId,
    setOcrConsent,
  } = useWorkspace();
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [busyAction, setBusyAction] = useState("");
  const [editor, setEditor] = useState<ModelDraft | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [contextMode, setContextMode] = useState<ContextMode>("128000");
  const [providerSummaries, setProviderSummaries] = useState<Record<string, CredentialSummary>>({});
  const [connections, setConnections] = useState<Record<string, ConnectionState>>({});

  const ocrModels = useMemo(
    () => customModels.filter((model) => providers.find((provider) => provider.id === model.providerId)?.format === "openai"),
    [customModels, providers],
  );
  const configuredCount = providers.filter((provider) => providerSummaries[provider.credentialId]?.configured).length;

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
        await configureOcrProvider(provider, model, ocrConsent);
      } else if (legacyOcr.configured) {
        setStatus({ kind: "info", message: "检测到已加密保存的 OCR 凭据，请在下方为 OCR 指定一个模型。" });
      }
    });
    // Registry hydration is intentionally limited to application startup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openNewModel = () => {
    setContextMode("128000");
    setShowKey(false);
    setEditor(emptyDraft());
    setStatus(null);
  };

  const openEditModel = (model: ModelConfig) => {
    const provider = providers.find((item) => item.id === model.providerId);
    if (!provider) {
      setStatus({ kind: "error", message: "该模型缺少接口配置。" });
      return;
    }
    setContextMode([128000, 256000, 1000000].includes(model.maxContextTokens) ? String(model.maxContextTokens) as ContextMode : "custom");
    setShowKey(false);
    setEditor({
      originalId: model.id,
      displayName: model.displayName,
      modelId: model.model,
      baseUrl: provider.baseUrl,
      format: provider.format,
      apiKey: "",
      maxContextTokens: model.maxContextTokens,
      useForMarkdown: model.id === markdownFormattingModelId,
      useForOcr: model.id === fullPageOcrModelId,
    });
    setStatus(null);
  };

  const saveModel = () => run("save-model", async () => {
    if (!editor) return;
    const id = editor.originalId ?? editor.modelId.trim();
    const modelName = editor.modelId.trim();
    const baseUrl = editor.baseUrl.trim().replace(/\/$/, "");
    const contextTokens = Number(editor.maxContextTokens);
    if (!id || !modelName || !baseUrl) throw new Error("Model ID 和 Base URL 均为必填项。");
    if (!Number.isInteger(contextTokens) || contextTokens < 4096 || contextTokens > 2_000_000) throw new Error("上下文长度必须是 4,096 到 2,000,000 之间的整数。" );
    if (!editor.originalId && customModels.some((model) => model.id === id)) throw new Error("该 Model ID 已存在，请直接编辑现有模型。");
    if (editor.useForOcr && editor.format !== "openai") throw new Error("全文 OCR 需要使用 OpenAI 兼容格式的模型。");
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(parsed.hostname)) throw new Error();
    } catch {
      throw new Error("Base URL 必须使用 HTTPS；仅本机测试允许 HTTP。");
    }
    const providerId = providerIdForModel(id);
    const provider: ProviderConfig = {
      id: providerId,
      name: editor.displayName.trim() || modelName,
      format: editor.format,
      baseUrl,
      credentialId: providerId,
      timeoutSeconds: 90,
    };
    const model: ModelConfig = {
      id,
      providerId,
      displayName: editor.displayName.trim() || modelName,
      model: modelName,
      maxContextTokens: contextTokens,
      maxOutputTokens: customModels.find((item) => item.id === id)?.maxOutputTokens ?? 4096,
    };

    let credentialReady = Boolean(providerSummaries[provider.credentialId]?.configured);
    if (editor.apiKey.trim()) {
      await saveProviderCredential(provider, editor.apiKey);
      credentialReady = true;
    } else if (!credentialReady) {
      const [recovered] = await hydrateProviderCredentials([provider]);
      credentialReady = recovered.configured;
    }
    if (!credentialReady) throw new Error("请输入 API Key。密钥将加密保存在 Stronghold 中。");

    addCustomModel(provider, model);
    setProviderSummaries((current) => ({ ...current, [provider.credentialId]: { credentialId: provider.credentialId, configured: true } }));

    const fallback = customModels.find((item) => item.id !== id)?.id ?? id;
    if (editor.useForMarkdown) setMarkdownFormattingModelId(id);
    else if (markdownFormattingModelId === id) setMarkdownFormattingModelId(fallback);

    if (editor.useForOcr) {
      await configureOcrProvider(provider, model, ocrConsent);
      setFullPageOcrModelId(id);
    } else if (fullPageOcrModelId === id) {
      await clearOcrProvider();
      setFullPageOcrModelId("");
    }

    setEditor(null);
    setShowKey(false);
    setConnections((current) => ({ ...current, [id]: "idle" }));
    setStatus({ kind: "success", message: `${model.displayName} 已保存，可以使用。` });
  });

  const removeModel = (modelId: string) => {
    const model = customModels.find((item) => item.id === modelId);
    if (!model || customModels.length <= 1) return;
    if (!window.confirm(`删除 ${model.displayName}？其加密保存的 API Key 也会一并删除。`)) return;
    void run(`remove-${modelId}`, async () => {
      const provider = providers.find((item) => item.id === model.providerId);
      const providerUseCount = customModels.filter((item) => item.providerId === provider?.id).length;
      if (modelId === fullPageOcrModelId) await clearOcrProvider();
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
      await clearOcrProvider();
      setFullPageOcrModelId("");
      setStatus({ kind: "info", message: "全文 OCR 已关闭。" });
      return;
    }
    const model = customModels.find((item) => item.id === modelId);
    const provider = providers.find((item) => item.id === model?.providerId);
    if (!model || !provider) throw new Error("OCR 模型配置不可用。");
    if (!providerSummaries[provider.credentialId]?.configured) throw new Error("请先为该模型保存 API Key，再将其用于 OCR。");
    await configureOcrProvider(provider, model, ocrConsent);
    setFullPageOcrModelId(modelId);
    setStatus({ kind: "success", message: `${model.displayName} 已用于全文 OCR。` });
  });

  const changeOcrConsent = (enabled: boolean) => run("ocr-consent", async () => {
    const model = customModels.find((item) => item.id === fullPageOcrModelId);
    const provider = providers.find((item) => item.id === model?.providerId);
    if (model && provider) await configureOcrProvider(provider, model, enabled);
    setOcrConsent(enabled);
    setStatus({ kind: enabled ? "success" : "info", message: enabled ? "已允许向指定 OCR 模型发送 PDF 渲染页。" : "已禁止上传 PDF 页面。" });
  });

  const testOcr = () => run("test-ocr", async () => {
    const model = customModels.find((item) => item.id === fullPageOcrModelId);
    const provider = providers.find((item) => item.id === model?.providerId);
    if (!model || !provider) throw new Error("请先选择全文 OCR 模型。");
    if (!ocrConsent) throw new Error("测试 OCR 前请先允许上传 PDF 页面。" );
    await configureOcrProvider(provider, model, true);
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

    {editor && <section className="settings-section model-editor-panel">
      <div className="model-editor-heading"><div><span className="section-icon"><Server size={16} /></span><div><h2>{editor.originalId ? "编辑模型" : "添加 API 模型"}</h2><p>{editor.originalId ? "更新接口参数；API Key 留空时继续使用已保存的密钥。" : "添加一个 OpenAI 或 Anthropic 兼容模型。"}</p></div></div><button className="icon-button" onClick={() => setEditor(null)} title="关闭编辑器"><X size={16} /></button></div>
      <div className="model-editor-grid">
        <label><span>显示名称 <small>可选</small></span><input value={editor.displayName} onChange={(event) => setEditor({ ...editor, displayName: event.target.value })} placeholder="推理模型" /></label>
        <label><span>Model ID</span><input value={editor.modelId} onChange={(event) => setEditor({ ...editor, modelId: event.target.value })} placeholder="qwen3.6-plus" disabled={Boolean(editor.originalId)} /></label>
        <label><span>接口格式</span><select value={editor.format} onChange={(event) => setEditor({ ...editor, format: event.target.value as ModelApiFormat })}><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic-compatible</option></select></label>
        <label><span>上下文长度</span><select value={contextMode} onChange={(event) => { const value = event.target.value as ContextMode; setContextMode(value); if (value !== "custom") setEditor({ ...editor, maxContextTokens: Number(value) }); }}><option value="128000">128K</option><option value="256000">256K</option><option value="1000000">1M</option><option value="custom">自定义</option></select></label>
        <label className="full-field"><span>自定义 Base URL</span><input value={editor.baseUrl} onChange={(event) => setEditor({ ...editor, baseUrl: event.target.value })} placeholder="https://gateway.example.com/v1" /></label>
        {contextMode === "custom" && <label><span>自定义上下文</span><div className="number-with-unit"><input type="number" min={4096} max={2000000} step={1024} value={editor.maxContextTokens} onChange={(event) => setEditor({ ...editor, maxContextTokens: Number(event.target.value) })} /><small>tokens</small></div></label>}
        <label><span>API Key</span><div className="secret-input"><input type={showKey ? "text" : "password"} value={editor.apiKey} onChange={(event) => setEditor({ ...editor, apiKey: event.target.value })} placeholder={editor.originalId ? "留空以继续使用已保存的密钥" : "将加密保存在 Stronghold"} autoComplete="off" /><button type="button" onClick={() => setShowKey((value) => !value)} title={showKey ? "隐藏密钥" : "显示密钥"}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></label>
      </div>
      <div className="model-editor-footer"><div className="model-role-options"><label><input type="checkbox" checked={editor.useForMarkdown} onChange={(event) => setEditor({ ...editor, useForMarkdown: event.target.checked })} /><FileText size={14} /> Markdown 整理</label><label><input type="checkbox" checked={editor.useForOcr} onChange={(event) => setEditor({ ...editor, useForOcr: event.target.checked })} /><ScanText size={14} /> 全文 OCR</label></div><div><button className="secondary-button" onClick={() => setEditor(null)}>取消</button><button className="primary-button compact" onClick={() => void saveModel()} disabled={busyAction === "save-model"}>{busyAction === "save-model" ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{editor.originalId ? "保存修改" : "添加模型"}</button></div></div>
    </section>}

    <section className="settings-section model-registry-section">
      <div className="settings-heading model-section-heading"><div><h2>模型列表</h2><p>{customModels.length} 个模型 · {configuredCount} 份加密凭据</p></div><span className="vault-badge"><ShieldCheck size={14} /> Stronghold</span></div>
      <div className="model-registry refined">
        {customModels.map((model) => {
          const provider = providers.find((item) => item.id === model.providerId);
          const configured = Boolean(provider && providerSummaries[provider.credentialId]?.configured);
          const connection = connections[model.id] ?? "idle";
          const roles = [model.id === markdownFormattingModelId ? "Markdown" : "", model.id === fullPageOcrModelId ? "OCR" : ""].filter(Boolean);
          return <article className="model-registry-row refined" key={model.id}>
            <span className={`model-health ${configured ? "ready" : "missing"}`} />
            <span className="model-format-badge">{provider?.format === "anthropic" ? "Anthropic" : "OpenAI"}</span>
            <span className="model-registry-copy"><span><strong>{model.displayName}</strong>{roles.map((role) => <em key={role}>{role}</em>)}</span><small>{model.model}</small><small className="model-endpoint" title={provider?.baseUrl}>{provider?.baseUrl ?? "缺少接口配置"}</small></span>
            <span className="model-context-summary"><strong>{contextLabel(model.maxContextTokens)}</strong><small>上下文</small></span>
            <span className={`credential-state ${configured ? "ready" : "missing"} ${connection}`}>
              {connection === "testing" ? <LoaderCircle className="spin" size={13} /> : connection === "error" ? <TriangleAlert size={13} /> : configured ? <KeyRound size={13} /> : <TriangleAlert size={13} />}
              {connection === "testing" ? "测试中" : connection === "success" ? "连接成功" : connection === "error" ? "连接失败" : configured ? "已加密" : "缺少密钥"}
            </span>
            <div className="model-row-actions"><button className="icon-button small" onClick={() => testModel(model.id)} title={`测试 ${model.displayName}`} disabled={!configured || Boolean(busyAction)}><Wifi size={14} /></button><button className="icon-button small" onClick={() => openEditModel(model)} title={`编辑 ${model.displayName}`}><Pencil size={14} /></button><button className="icon-button small danger-icon" onClick={() => removeModel(model.id)} title={`删除 ${model.displayName}`} disabled={customModels.length <= 1 || Boolean(busyAction)}><Trash2 size={14} /></button></div>
          </article>;
        })}
      </div>
    </section>

    <section className="settings-section workflow-settings-section">
      <div className="settings-heading"><div><h2>文档处理</h2><p>为处理任务指定已配置的模型，无需重复保存密钥。</p></div><Bot size={18} /></div>
      <div className="workflow-row"><span className="workflow-icon markdown"><FileText size={17} /></span><span className="workflow-copy"><strong>Markdown 整理</strong><small>保留引用与公式，整理解析文本的结构和换行</small></span><select aria-label="Markdown 整理模型" value={markdownFormattingModelId} onChange={(event) => setMarkdownFormattingModelId(event.target.value)}>{customModels.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select><label className="compact-switch"><input type="checkbox" checked={autoFormatMarkdown} onChange={(event) => setAutoFormatMarkdown(event.target.checked)} /><span /></label></div>
      <div className="workflow-row"><span className="workflow-icon ocr"><ScanText size={17} /></span><span className="workflow-copy"><strong>全文 OCR</strong><small>使用 OpenAI 兼容的视觉模型识别渲染页面</small></span><select aria-label="全文 OCR 模型" value={fullPageOcrModelId} onChange={(event) => void assignOcrModel(event.target.value)} disabled={busyAction === "assign-ocr"}><option value="">关闭</option>{ocrModels.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select><button className="icon-button" onClick={() => void testOcr()} title="测试全文 OCR" disabled={!fullPageOcrModelId || !ocrConsent || Boolean(busyAction)}>{busyAction === "test-ocr" ? <LoaderCircle className="spin" size={15} /> : <Wifi size={15} />}</button></div>
      <div className="workflow-row"><span className="workflow-icon vision"><ImageIcon size={17} /></span><span className="workflow-copy"><strong>图片解读</strong><small>导入后自动分析插图，并修复质量检查发现的可疑公式</small></span><select aria-label="图片解读模型" value={visionAnalysisModelId} onChange={(event) => setVisionAnalysisModelId(event.target.value)}><option value="">未配置</option>{customModels.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select><span className={`workflow-state ${visionAnalysisModelId ? "ready" : "off"}`}>{visionAnalysisModelId ? "自动" : "关闭"}</span></div>
      <div className="ocr-consent-row"><ShieldCheck size={16} /><span><strong>发送 PDF 页面</strong><small>渲染页会在本地缓存，只有启用后才会发送给所选模型。</small></span><label className="compact-switch"><input type="checkbox" checked={ocrConsent} onChange={(event) => void changeOcrConsent(event.target.checked)} disabled={Boolean(busyAction)} /><span /></label></div>
    </section>

  </main>;
}
