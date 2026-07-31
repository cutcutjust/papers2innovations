import { useMemo, useState } from "react";
import { Check, Eye, EyeOff, FileText, Image as ImageIcon, LoaderCircle, ScanText, X } from "lucide-react";
import type { ModelCapability, ModelConfig, ProviderConfig } from "@p2i/contracts";
import {
  clearOcrProvider,
  configureOcrProvider,
  hydrateProviderCredentials,
  saveProviderCredential,
  testProviderConnection,
} from "../lib/credentials";
import { providerIdForModel } from "../lib/providerConfig";
import { useWorkspace, type ModelApiFormat } from "../store";
import { modelHasCapability } from "../lib/modelCapabilities";

type ContextMode = "128000" | "256000" | "1000000" | "custom";
export type ModelSetupRole = "text" | "vision";
export type ModelSetupStatus = { kind: "success" | "error" | "info"; message: string };

interface Props {
  model?: ModelConfig;
  presetRole?: ModelSetupRole;
  compact?: boolean;
  onSaved: (model: ModelConfig) => void;
  onCancel: () => void;
  onStatus?: (status: ModelSetupStatus) => void;
}

const contextModeFor = (tokens: number): ContextMode =>
  [128000, 256000, 1000000].includes(tokens) ? String(tokens) as ContextMode : "custom";

export function ModelSetupPanel({ model, presetRole = "text", compact = false, onSaved, onCancel, onStatus }: Props) {
  const workspace = useWorkspace();
  const provider = workspace.providers.find((item) => item.id === model?.providerId);
  const [displayName, setDisplayName] = useState(model?.displayName ?? "");
  const [modelId, setModelId] = useState(model?.model ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [format, setFormat] = useState<ModelApiFormat>(provider?.format ?? "openai");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [maxContextTokens, setMaxContextTokens] = useState(model?.maxContextTokens ?? 128000);
  const [contextMode, setContextMode] = useState<ContextMode>(contextModeFor(model?.maxContextTokens ?? 128000));
  const [useForText, setUseForText] = useState(model ? model.id === workspace.defaultTextModelId || modelHasCapability(model, "text") : presetRole === "text");
  const [useForVision, setUseForVision] = useState(model ? model.id === workspace.visionAnalysisModelId || modelHasCapability(model, "vision") : presetRole === "vision");
  const [useForOcr, setUseForOcr] = useState(Boolean(model && model.id === workspace.fullPageOcrModelId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const roleSummary = useMemo(() => [useForText ? "文本" : "", useForVision ? "视觉重建" : "", useForOcr ? "兼容 OCR" : ""].filter(Boolean), [useForOcr, useForText, useForVision]);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const id = model?.id ?? modelId.trim();
      const resolvedModelId = modelId.trim();
      const resolvedBaseUrl = baseUrl.trim().replace(/\/$/, "");
      const contextTokens = Number(maxContextTokens);
      if (!id || !resolvedModelId || !resolvedBaseUrl) throw new Error("Model ID 和 Base URL 均为必填项。");
      if (!roleSummary.length) throw new Error("请至少选择一个模型用途。");
      if (!Number.isInteger(contextTokens) || contextTokens < 4096 || contextTokens > 2_000_000) throw new Error("上下文长度必须是 4,096 到 2,000,000 之间的整数。");
      if (!model && workspace.customModels.some((item) => item.id === id)) throw new Error("该 Model ID 已存在，请直接编辑现有模型。");
      if (useForOcr && format !== "openai") throw new Error("全文 OCR 需要使用 OpenAI 兼容格式的模型。");
      try {
        const parsed = new URL(resolvedBaseUrl);
        if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(parsed.hostname)) throw new Error();
      } catch {
        throw new Error("Base URL 必须使用 HTTPS；仅本机测试允许 HTTP。");
      }

      const providerId = providerIdForModel(id);
      const nextProvider: ProviderConfig = {
        id: providerId,
        name: displayName.trim() || resolvedModelId,
        format,
        baseUrl: resolvedBaseUrl,
        credentialId: providerId,
        timeoutSeconds: 90,
      };
      const capabilities: ModelCapability[] = [useForText ? "text" : null, useForVision || useForOcr ? "vision" : null].filter((item): item is ModelCapability => Boolean(item));
      const nextModel: ModelConfig = {
        id,
        providerId,
        displayName: displayName.trim() || resolvedModelId,
        model: resolvedModelId,
        maxContextTokens: contextTokens,
        maxOutputTokens: model?.maxOutputTokens ?? 4096,
        capabilities,
      };

      let credentialReady = false;
      if (apiKey.trim()) {
        await saveProviderCredential(nextProvider, apiKey);
        credentialReady = true;
      } else {
        const [summary] = await hydrateProviderCredentials([nextProvider]);
        credentialReady = summary.configured;
      }
      if (!credentialReady) throw new Error("请输入 API Key。密钥只会加密保存在 Stronghold 中。");

      const connection = await testProviderConnection(nextProvider, nextModel);
      if (!connection.ok) throw new Error(`凭据已安全保存，但接口返回 HTTP ${connection.status}。请检查 Base URL、Model ID 或账户权限。`);

      workspace.addCustomModel(nextProvider, nextModel);
      if (useForText) {
        workspace.setDefaultTextModelId(id);
        workspace.setContextCompressionModelId(id);
        if (!workspace.translationModelId) workspace.setTranslationModelId(id);
      } else if (workspace.defaultTextModelId === id) {
        workspace.setDefaultTextModelId("");
      }
      if (useForVision) workspace.setVisionAnalysisModelId(id);
      else if (workspace.visionAnalysisModelId === id) workspace.setVisionAnalysisModelId("");
      if (useForOcr) {
        await configureOcrProvider(nextProvider, nextModel, workspace.ocrConsent);
        workspace.setFullPageOcrModelId(id);
      } else if (workspace.fullPageOcrModelId === id) {
        await clearOcrProvider();
        workspace.setFullPageOcrModelId("");
      }
      onStatus?.({ kind: "success", message: `${nextModel.displayName} 已连接并保存。` });
      onSaved(nextModel);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      onStatus?.({ kind: "error", message });
    } finally {
      setBusy(false);
    }
  };

  return <section className={`model-editor-panel shared-model-setup ${compact ? "compact" : ""}`}>
    <div className="model-editor-heading"><div><span className="section-icon"><FileText size={16} /></span><div><h2>{model ? "编辑模型" : presetRole === "vision" ? "配置视觉模型" : "配置文本模型"}</h2><p>保存前会测试连接，API Key 只进入 Stronghold。</p></div></div><button className="icon-button" onClick={onCancel} title="关闭"><X size={16} /></button></div>
    <div className="model-editor-grid">
      <label><span>显示名称 <small>可选</small></span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder={presetRole === "vision" ? "视觉理解模型" : "论文阅读模型"} /></label>
      <label><span>Model ID</span><input value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="qwen-plus" disabled={Boolean(model)} /></label>
      <label><span>接口格式</span><select value={format} onChange={(event) => setFormat(event.target.value as ModelApiFormat)}><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic-compatible</option></select></label>
      <label><span>上下文长度</span><select value={contextMode} onChange={(event) => { const value = event.target.value as ContextMode; setContextMode(value); if (value !== "custom") setMaxContextTokens(Number(value)); }}><option value="128000">128K</option><option value="256000">256K</option><option value="1000000">1M</option><option value="custom">自定义</option></select></label>
      <label className="full-field"><span>自定义 Base URL</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://gateway.example.com/v1" /></label>
      {contextMode === "custom" && <label><span>自定义上下文</span><div className="number-with-unit"><input type="number" min={4096} max={2000000} step={1024} value={maxContextTokens} onChange={(event) => setMaxContextTokens(Number(event.target.value))} /><small>tokens</small></div></label>}
      <label><span>API Key</span><div className="secret-input"><input type={showKey ? "text" : "password"} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={model ? "留空继续使用已保存密钥" : "将加密保存到 Stronghold"} autoComplete="off" /><button type="button" onClick={() => setShowKey((value) => !value)} title={showKey ? "隐藏密钥" : "显示密钥"}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></label>
    </div>
    <div className="model-role-grid">
      <label className={useForText ? "active" : ""}><input type="checkbox" checked={useForText} onChange={(event) => setUseForText(event.target.checked)} /><FileText size={15} /><span><strong>默认文本模型</strong><small>阅读、翻译、解释与研究推理</small></span></label>
      <label className={useForVision ? "active" : ""}><input type="checkbox" checked={useForVision} onChange={(event) => setUseForVision(event.target.checked)} /><ImageIcon size={15} /><span><strong>视觉重建模型</strong><small>逐页生成 Markdown、插图分析与公式复核</small></span></label>
      <label className={useForOcr ? "active" : ""}><input type="checkbox" checked={useForOcr} onChange={(event) => setUseForOcr(event.target.checked)} /><ScanText size={15} /><span><strong>全文 OCR</strong><small>仅 OpenAI-compatible；页面上传仍需另行同意</small></span></label>
    </div>
    {error && <p className="model-setup-error" role="alert">{error}</p>}
    <div className="model-editor-footer"><small>{roleSummary.length ? `将用于：${roleSummary.join("、")}` : "请至少选择一个用途"}</small><div><button className="secondary-button" onClick={onCancel}>取消</button><button className="primary-button compact" onClick={() => void submit()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{busy ? "正在验证" : model ? "保存并测试" : "连接并保存"}</button></div></div>
  </section>;
}
