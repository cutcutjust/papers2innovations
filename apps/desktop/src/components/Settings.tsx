import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Check,
  CheckCircle2,
  Eye,
  EyeOff,
  FileText,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  ScanText,
  Server,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Type,
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
import { nativeRuntime, uninstallApplication } from "../lib/bridge";
import { providerIdForModel } from "../lib/providerConfig";
import { useWorkspace, type ModelApiFormat } from "../store";
import type { FontSize } from "../lib/fontSize";

const BAILIAN_BEIJING_URL = "https://llm-1wr4xxvuguzv06on.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";

const endpointPresets = {
  custom: { label: "Custom endpoint", baseUrl: "", format: "openai" as ModelApiFormat },
  bailian: { label: "Bailian compatible", baseUrl: BAILIAN_BEIJING_URL, format: "openai" as ModelApiFormat },
  deepseek: { label: "DeepSeek compatible", baseUrl: "https://api.deepseek.com", format: "openai" as ModelApiFormat },
  openai: { label: "OpenAI compatible", baseUrl: "https://api.openai.com/v1", format: "openai" as ModelApiFormat },
  anthropic: { label: "Anthropic compatible", baseUrl: "https://api.anthropic.com/v1", format: "anthropic" as ModelApiFormat },
};

type PresetId = keyof typeof endpointPresets;
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
    ocrConsent,
    fontSize,
    addCustomModel,
    removeCustomModel,
    setMarkdownFormattingModelId,
    setAutoFormatMarkdown,
    setFullPageOcrModelId,
    setOcrConsent,
    setFontSize,
  } = useWorkspace();
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [busyAction, setBusyAction] = useState("");
  const [editor, setEditor] = useState<ModelDraft | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [preset, setPreset] = useState<PresetId>("custom");
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
        setStatus({ kind: "info", message: "Existing OCR access is protected. Assign a model below to manage it from this registry." });
      }
    });
    // Registry hydration is intentionally limited to application startup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openNewModel = () => {
    setPreset("custom");
    setShowKey(false);
    setEditor(emptyDraft());
    setStatus(null);
  };

  const openEditModel = (model: ModelConfig) => {
    const provider = providers.find((item) => item.id === model.providerId);
    if (!provider) {
      setStatus({ kind: "error", message: "This model has no provider configuration." });
      return;
    }
    setPreset("custom");
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

  const selectPreset = (presetId: PresetId) => {
    const selected = endpointPresets[presetId];
    setPreset(presetId);
    setEditor((current) => current ? {
      ...current,
      baseUrl: selected.baseUrl || current.baseUrl,
      format: selected.format,
    } : current);
  };

  const saveModel = () => run("save-model", async () => {
    if (!editor) return;
    const id = editor.originalId ?? editor.modelId.trim();
    const modelName = editor.modelId.trim();
    const baseUrl = editor.baseUrl.trim().replace(/\/$/, "");
    if (!id || !modelName || !baseUrl) throw new Error("Model ID and Base URL are required.");
    if (!editor.originalId && customModels.some((model) => model.id === id)) throw new Error("This Model ID already exists. Edit the existing model instead.");
    if (editor.useForOcr && editor.format !== "openai") throw new Error("Full-page OCR requires an OpenAI-compatible model.");
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(parsed.hostname)) throw new Error();
    } catch {
      throw new Error("Base URL must use HTTPS. Localhost HTTP is allowed for testing.");
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
      maxContextTokens: Math.max(4096, Math.min(2_000_000, Number(editor.maxContextTokens) || 128000)),
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
    if (!credentialReady) throw new Error("Enter an API key. It will be encrypted in Stronghold.");

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
    setStatus({ kind: "success", message: `${model.displayName} is saved and ready.` });
  });

  const removeModel = (modelId: string) => {
    const model = customModels.find((item) => item.id === modelId);
    if (!model || customModels.length <= 1) return;
    if (!window.confirm(`Remove ${model.displayName}? Its encrypted API key will also be deleted.`)) return;
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
      setStatus({ kind: "success", message: `${model.displayName} and its encrypted credential were removed.` });
    });
  };

  const testModel = (modelId: string) => {
    setConnections((current) => ({ ...current, [modelId]: "testing" }));
    void run(`test-${modelId}`, async () => {
      const model = customModels.find((item) => item.id === modelId);
      const provider = providers.find((item) => item.id === model?.providerId);
      if (!model || !provider) throw new Error("Provider configuration is unavailable.");
      try {
        const result = await testProviderConnection(provider, model);
        if (!result.ok) throw new Error(`${model.displayName} returned HTTP ${result.status}.`);
        setConnections((current) => ({ ...current, [modelId]: "success" }));
        setStatus({ kind: "success", message: `${model.displayName} connection succeeded.` });
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
      setStatus({ kind: "info", message: "Full-page OCR is disabled." });
      return;
    }
    const model = customModels.find((item) => item.id === modelId);
    const provider = providers.find((item) => item.id === model?.providerId);
    if (!model || !provider) throw new Error("OCR model configuration is unavailable.");
    if (!providerSummaries[provider.credentialId]?.configured) throw new Error("Add an API key to this model before assigning it to OCR.");
    await configureOcrProvider(provider, model, ocrConsent);
    setFullPageOcrModelId(modelId);
    setStatus({ kind: "success", message: `${model.displayName} is assigned to full-page OCR.` });
  });

  const changeOcrConsent = (enabled: boolean) => run("ocr-consent", async () => {
    const model = customModels.find((item) => item.id === fullPageOcrModelId);
    const provider = providers.find((item) => item.id === model?.providerId);
    if (model && provider) await configureOcrProvider(provider, model, enabled);
    setOcrConsent(enabled);
    setStatus({ kind: enabled ? "success" : "info", message: enabled ? "PDF page upload is enabled for the assigned OCR model." : "PDF page upload is disabled." });
  });

  const testOcr = () => run("test-ocr", async () => {
    const model = customModels.find((item) => item.id === fullPageOcrModelId);
    const provider = providers.find((item) => item.id === model?.providerId);
    if (!model || !provider) throw new Error("Choose a full-page OCR model first.");
    if (!ocrConsent) throw new Error("Enable PDF page upload before testing OCR.");
    await configureOcrProvider(provider, model, true);
    const result = await testQwenConnection();
    if (result.requiresWorkspace) throw new Error("This account requires its dedicated business workspace Base URL.");
    if (!result.ok) throw new Error(`${model.displayName} OCR test returned HTTP ${result.status}.`);
    setStatus({ kind: "success", message: `${model.displayName} OCR connection succeeded.` });
  });

  const uninstall = () => {
    if (!window.confirm("Uninstall Papers2Innovations from this computer? Your paper library will be kept.")) return;
    void run("uninstall", uninstallApplication);
  };

  return <main className="settings-page settings-page-refined">
    <header className="settings-hero">
      <div className="page-title-block"><div className="page-icon"><ShieldCheck size={20} /></div><div><h1>Models & security</h1><p>AI endpoints, document workflows and encrypted credentials</p></div></div>
      <div className="settings-hero-actions">
        <div className="font-size-setting"><Type size={15} /><span>Text size</span><div className="segmented-control" aria-label="System text size">{(["small", "medium", "large"] as FontSize[]).map((size) => <button key={size} className={fontSize === size ? "active" : ""} onClick={() => setFontSize(size)} aria-pressed={fontSize === size}>{size === "small" ? "Small" : size === "medium" ? "Medium" : "Large"}</button>)}</div></div>
        <button className="primary-button compact" onClick={openNewModel}><Plus size={15} /> Add model</button>
      </div>
    </header>

    {status && <div className={`settings-status settings-global-status ${status.kind}`} role={status.kind === "error" ? "alert" : "status"}>{status.kind === "error" ? <TriangleAlert size={16} /> : <CheckCircle2 size={16} />}<span>{status.message}</span><button onClick={() => setStatus(null)} title="Dismiss"><X size={14} /></button></div>}

    {editor && <section className="settings-section model-editor-panel">
      <div className="model-editor-heading"><div><span className="section-icon"><Server size={16} /></span><div><h2>{editor.originalId ? "Edit model" : "Add API model"}</h2><p>{editor.originalId ? "Update connection details or replace the encrypted key." : "Create one reusable connection for any compatible model."}</p></div></div><button className="icon-button" onClick={() => setEditor(null)} title="Close editor"><X size={16} /></button></div>
      <div className="model-editor-grid">
        <label><span>Display name <small>optional</small></span><input value={editor.displayName} onChange={(event) => setEditor({ ...editor, displayName: event.target.value })} placeholder="Reasoning" /></label>
        <label><span>Model ID</span><input value={editor.modelId} onChange={(event) => setEditor({ ...editor, modelId: event.target.value })} placeholder="qwen3.6-plus" disabled={Boolean(editor.originalId)} /></label>
        <label><span>Endpoint preset</span><select value={preset} onChange={(event) => selectPreset(event.target.value as PresetId)}>{Object.entries(endpointPresets).map(([id, item]) => <option key={id} value={id}>{item.label}</option>)}</select></label>
        <label><span>API format</span><select value={editor.format} onChange={(event) => setEditor({ ...editor, format: event.target.value as ModelApiFormat })}><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic-compatible</option></select></label>
        <label className="full-field"><span>Base URL</span><input value={editor.baseUrl} onChange={(event) => { setPreset("custom"); setEditor({ ...editor, baseUrl: event.target.value }); }} placeholder="https://gateway.example.com/v1" /></label>
        <label><span>Maximum context</span><div className="number-with-unit"><input type="number" min={4096} max={2000000} step={1024} value={editor.maxContextTokens} onChange={(event) => setEditor({ ...editor, maxContextTokens: Number(event.target.value) })} /><small>tokens</small></div></label>
        <label><span>API key</span><div className="secret-input"><input type={showKey ? "text" : "password"} value={editor.apiKey} onChange={(event) => setEditor({ ...editor, apiKey: event.target.value })} placeholder={editor.originalId ? "Leave blank to keep the stored key" : "Encrypted in Stronghold"} autoComplete="off" /><button type="button" onClick={() => setShowKey((value) => !value)} title={showKey ? "Hide key" : "Show key"}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></label>
      </div>
      <div className="model-editor-footer"><div className="model-role-options"><label><input type="checkbox" checked={editor.useForMarkdown} onChange={(event) => setEditor({ ...editor, useForMarkdown: event.target.checked })} /><FileText size={14} /> Markdown cleanup</label><label><input type="checkbox" checked={editor.useForOcr} onChange={(event) => setEditor({ ...editor, useForOcr: event.target.checked })} /><ScanText size={14} /> Full-page OCR</label></div><div><button className="secondary-button" onClick={() => setEditor(null)}>Cancel</button><button className="primary-button compact" onClick={() => void saveModel()} disabled={busyAction === "save-model"}>{busyAction === "save-model" ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{editor.originalId ? "Save changes" : "Add model"}</button></div></div>
    </section>}

    <section className="settings-section model-registry-section">
      <div className="settings-heading model-section-heading"><div><h2>Model registry</h2><p>{customModels.length} models · {configuredCount} encrypted credentials</p></div><span className="vault-badge"><ShieldCheck size={14} /> Stronghold</span></div>
      <div className="model-registry refined">
        {customModels.map((model) => {
          const provider = providers.find((item) => item.id === model.providerId);
          const configured = Boolean(provider && providerSummaries[provider.credentialId]?.configured);
          const connection = connections[model.id] ?? "idle";
          const roles = [model.id === markdownFormattingModelId ? "Markdown" : "", model.id === fullPageOcrModelId ? "OCR" : ""].filter(Boolean);
          return <article className="model-registry-row refined" key={model.id}>
            <span className={`model-health ${configured ? "ready" : "missing"}`} />
            <span className="model-format-badge">{provider?.format === "anthropic" ? "Anthropic" : "OpenAI"}</span>
            <span className="model-registry-copy"><span><strong>{model.displayName}</strong>{roles.map((role) => <em key={role}>{role}</em>)}</span><small>{model.model}</small><small className="model-endpoint" title={provider?.baseUrl}>{provider?.baseUrl ?? "Provider missing"}</small></span>
            <span className="model-context-summary"><strong>{contextLabel(model.maxContextTokens)}</strong><small>context</small></span>
            <span className={`credential-state ${configured ? "ready" : "missing"} ${connection}`}>
              {connection === "testing" ? <LoaderCircle className="spin" size={13} /> : connection === "error" ? <TriangleAlert size={13} /> : configured ? <KeyRound size={13} /> : <TriangleAlert size={13} />}
              {connection === "testing" ? "Testing" : connection === "success" ? "Connected" : connection === "error" ? "Failed" : configured ? "Encrypted" : "Needs key"}
            </span>
            <div className="model-row-actions"><button className="icon-button small" onClick={() => testModel(model.id)} title={`Test ${model.displayName}`} disabled={!configured || Boolean(busyAction)}><Wifi size={14} /></button><button className="icon-button small" onClick={() => openEditModel(model)} title={`Edit ${model.displayName}`}><Pencil size={14} /></button><button className="icon-button small danger-icon" onClick={() => removeModel(model.id)} title={`Remove ${model.displayName}`} disabled={customModels.length <= 1 || Boolean(busyAction)}><Trash2 size={14} /></button></div>
          </article>;
        })}
      </div>
    </section>

    <section className="settings-section workflow-settings-section">
      <div className="settings-heading"><div><h2>Document workflows</h2><p>Assign configured models without duplicating credentials.</p></div><Bot size={18} /></div>
      <div className="workflow-row"><span className="workflow-icon markdown"><FileText size={17} /></span><span className="workflow-copy"><strong>Markdown cleanup</strong><small>Structure parsed text while preserving citations and formulas</small></span><select aria-label="Markdown cleanup model" value={markdownFormattingModelId} onChange={(event) => setMarkdownFormattingModelId(event.target.value)}>{customModels.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select><label className="compact-switch"><input type="checkbox" checked={autoFormatMarkdown} onChange={(event) => setAutoFormatMarkdown(event.target.checked)} /><span /></label></div>
      <div className="workflow-row"><span className="workflow-icon ocr"><ScanText size={17} /></span><span className="workflow-copy"><strong>Full-page OCR</strong><small>Use an OpenAI-compatible vision model for rendered pages</small></span><select aria-label="Full-page OCR model" value={fullPageOcrModelId} onChange={(event) => void assignOcrModel(event.target.value)} disabled={busyAction === "assign-ocr"}><option value="">Disabled</option>{ocrModels.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select><button className="icon-button" onClick={() => void testOcr()} title="Test full-page OCR" disabled={!fullPageOcrModelId || !ocrConsent || Boolean(busyAction)}>{busyAction === "test-ocr" ? <LoaderCircle className="spin" size={15} /> : <Wifi size={15} />}</button></div>
      <div className="ocr-consent-row"><ShieldCheck size={16} /><span><strong>PDF page upload</strong><small>Rendered pages are cached locally and sent only when enabled.</small></span><label className="compact-switch"><input type="checkbox" checked={ocrConsent} onChange={(event) => void changeOcrConsent(event.target.checked)} disabled={Boolean(busyAction)} /><span /></label></div>
    </section>

    <section className="security-facts"><div><span>Credential vault</span><strong>Stronghold + keychain</strong></div><div><span>Python & database</span><strong>No secret access</strong></div><div><span>OCR concurrency</span><strong>2 pages</strong></div><div><span>Retry policy</span><strong>2 / 4 / 8 seconds</strong></div></section>
    {nativeRuntime && <section className="settings-section app-management"><div className="settings-heading"><div><h2>Application</h2><p>Uninstall the desktop app while keeping the paper library.</p></div><Trash2 size={18} /></div><button className="danger-button" onClick={uninstall} disabled={Boolean(busyAction)}><Trash2 size={15} /> Uninstall Papers2Innovations</button></section>}
  </main>;
}
