import { useEffect, useMemo, useState } from "react";
import { Bot, CheckCircle2, LoaderCircle, Plus, ShieldCheck, Trash2, TriangleAlert, Wifi } from "lucide-react";
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

const BAILIAN_BEIJING_URL = "https://llm-1wr4xxvuguzv06on.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";

type SettingsStatus = { kind: "success" | "error" | "info"; message: string };

export function Settings() {
  const {
    customModels,
    providers,
    markdownFormattingModelId,
    autoFormatMarkdown,
    fullPageOcrModelId,
    ocrConsent,
    addCustomModel,
    updateCustomModel,
    removeCustomModel,
    setMarkdownFormattingModelId,
    setAutoFormatMarkdown,
    setFullPageOcrModelId,
    setOcrConsent,
  } = useWorkspace();
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [modelName, setModelName] = useState("");
  const [modelId, setModelId] = useState("");
  const [modelBaseUrl, setModelBaseUrl] = useState("");
  const [modelFormat, setModelFormat] = useState<ModelApiFormat>("openai");
  const [modelApiKey, setModelApiKey] = useState("");
  const [modelMaxContext, setModelMaxContext] = useState(128000);
  const [assignFormatting, setAssignFormatting] = useState(false);
  const [assignOcr, setAssignOcr] = useState(false);
  const [providerSummaries, setProviderSummaries] = useState<Record<string, CredentialSummary>>({});

  const ocrModels = useMemo(() => customModels.filter((model) => providers.find((provider) => provider.id === model.providerId)?.format === "openai"), [customModels, providers]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setStatus(null);
    try {
      await action();
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void run(async () => {
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
        setStatus({ kind: "success", message: "Encrypted model credentials are ready." });
      } else if (legacyOcr.configured) {
        setStatus({ kind: "info", message: "Existing encrypted OCR access remains active. Assign a model below to manage it from the unified registry." });
      } else {
        setStatus({ kind: "info", message: "Stronghold is ready. Add an API model to begin." });
      }
    });
    // Hydration runs once for the registry loaded at application startup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addModel = () => run(async () => {
    const id = modelId.trim();
    if (!id || !modelBaseUrl.trim() || !modelApiKey.trim()) throw new Error("Model ID, Base URL and API key are required.");
    if (assignOcr && modelFormat !== "openai") throw new Error("Full-page OCR requires an OpenAI-compatible model.");
    if (assignOcr && !ocrConsent) throw new Error("Allow PDF page upload before assigning a full-page OCR model.");
    const providerId = providerIdForModel(id);
    const provider: ProviderConfig = {
      id: providerId,
      name: modelName.trim() || id,
      format: modelFormat,
      baseUrl: modelBaseUrl.trim().replace(/\/$/, ""),
      credentialId: providerId,
      timeoutSeconds: 90,
    };
    const model: ModelConfig = {
      id,
      providerId: provider.id,
      displayName: modelName.trim() || id,
      model: id,
      maxContextTokens: Math.max(4096, Math.min(2_000_000, modelMaxContext)),
      maxOutputTokens: 4096,
    };
    await saveProviderCredential(provider, modelApiKey);
    addCustomModel(provider, model);
    setProviderSummaries((current) => ({ ...current, [provider.credentialId]: { credentialId: provider.credentialId, configured: true } }));
    if (assignFormatting) setMarkdownFormattingModelId(model.id);
    if (assignOcr) {
      await configureOcrProvider(provider, model, ocrConsent);
      setFullPageOcrModelId(model.id);
    }
    setModelName("");
    setModelId("");
    setModelBaseUrl("");
    setModelApiKey("");
    setModelMaxContext(128000);
    setAssignFormatting(false);
    setAssignOcr(false);
    setStatus({ kind: "success", message: `${model.displayName} was encrypted and added to the shared model registry.` });
  });

  const removeModel = (modelIdToRemove: string) => run(async () => {
    const model = customModels.find((item) => item.id === modelIdToRemove);
    const provider = providers.find((item) => item.id === model?.providerId);
    const providerUseCount = customModels.filter((item) => item.providerId === provider?.id).length;
    if (modelIdToRemove === fullPageOcrModelId) await clearOcrProvider();
    if (provider && providerUseCount <= 1) await deleteProviderCredential(provider.credentialId);
    removeCustomModel(modelIdToRemove);
    setStatus({ kind: "success", message: `${model?.displayName ?? modelIdToRemove} was removed.` });
  });

  const testModel = (modelIdToTest: string) => run(async () => {
    const model = customModels.find((item) => item.id === modelIdToTest);
    const provider = providers.find((item) => item.id === model?.providerId);
    if (!model || !provider) throw new Error("Provider configuration is unavailable.");
    const result = await testProviderConnection(provider, model);
    if (!result.ok) throw new Error(`${model.displayName} connection failed (HTTP ${result.status}).`);
    setStatus({ kind: "success", message: `${model.displayName} connection succeeded (HTTP ${result.status}).` });
  });

  const assignOcrModel = (nextModelId: string) => run(async () => {
    if (!nextModelId) {
      await clearOcrProvider();
      setFullPageOcrModelId("");
      setStatus({ kind: "info", message: "Full-page OCR is disabled." });
      return;
    }
    const model = customModels.find((item) => item.id === nextModelId);
    const provider = providers.find((item) => item.id === model?.providerId);
    if (!model || !provider) throw new Error("OCR model configuration is unavailable.");
    if (!providerSummaries[provider.credentialId]?.configured) throw new Error("This model needs a Stronghold credential before it can run OCR.");
    await configureOcrProvider(provider, model, ocrConsent);
    setFullPageOcrModelId(nextModelId);
    setStatus({ kind: "success", message: `${model.displayName} is now assigned to full-page OCR.` });
  });

  const changeOcrConsent = (enabled: boolean) => run(async () => {
    const model = customModels.find((item) => item.id === fullPageOcrModelId);
    const provider = providers.find((item) => item.id === model?.providerId);
    if (model && provider) await configureOcrProvider(provider, model, enabled);
    setOcrConsent(enabled);
    setStatus({ kind: enabled ? "success" : "info", message: enabled ? "Encrypted full-page OCR is enabled." : "PDF page upload is disabled." });
  });

  const testOcr = () => run(async () => {
    const model = customModels.find((item) => item.id === fullPageOcrModelId);
    const provider = providers.find((item) => item.id === model?.providerId);
    if (!model || !provider) throw new Error("Choose a full-page OCR model first.");
    if (!ocrConsent) throw new Error("Allow PDF page upload before testing full-page OCR.");
    await configureOcrProvider(provider, model, true);
    const result = await testQwenConnection();
    if (result.requiresWorkspace) throw new Error("This endpoint requires a dedicated business workspace URL.");
    if (!result.ok) throw new Error(`${model.displayName} OCR connection failed (HTTP ${result.status}).`);
    setStatus({ kind: "success", message: `${model.displayName} OCR connection succeeded (HTTP ${result.status}).` });
  });

  const uninstall = () => {
    if (!window.confirm("Uninstall Papers2Innovations from this computer? Your paper library will be kept.")) return;
    void run(uninstallApplication);
  };

  return <main className="settings-page">
    <div className="page-title-block"><div className="page-icon"><ShieldCheck size={20} /></div><div><h1>Models & security</h1><p>One encrypted registry for AI workflows, Markdown cleanup and full-page OCR.</p></div></div>
    <section className="settings-section model-settings-section">
      <div className="settings-heading"><div><h2>AI models</h2><p>Configure any compatible endpoint once, then assign it to document workflows.</p></div><Bot size={18} /></div>
      <div className="model-registry">
        {customModels.map((model) => {
          const provider = providers.find((item) => item.id === model.providerId);
          const providerConfigured = provider ? providerSummaries[provider.credentialId]?.configured : false;
          const roles = [model.id === markdownFormattingModelId ? "Markdown" : "", model.id === fullPageOcrModelId ? "OCR" : ""].filter(Boolean).join(" + ");
          return <div className="model-registry-row" key={model.id}>
            <span className="model-format-badge">{provider?.format === "anthropic" ? "Anthropic" : "OpenAI"}</span>
            <span className="model-registry-copy"><strong>{model.displayName}{roles && <em>{roles}</em>}</strong><small>{model.model} / {provider?.baseUrl ?? "Missing provider"} / {providerConfigured ? "Credential stored" : "Needs key"}</small></span>
            <label className="model-context-limit"><span>Context</span><input aria-label={`${model.displayName} maximum context tokens`} type="number" min={4096} max={2000000} step={1024} defaultValue={model.maxContextTokens} onBlur={(event) => { const value = Math.max(4096, Math.min(2_000_000, Number(event.target.value) || 128000)); event.currentTarget.value = String(value); updateCustomModel(model.id, { maxContextTokens: value }); }} /><small>tokens</small></label>
            <button className="icon-button small" onClick={() => void testModel(model.id)} title={`Test ${model.displayName}`} disabled={busy || !providerConfigured}><Wifi size={14} /></button>
            <button className="icon-button small" onClick={() => void removeModel(model.id)} title={`Remove ${model.displayName}`} disabled={busy || customModels.length === 1}><Trash2 size={14} /></button>
          </div>;
        })}
      </div>

      <div className="model-purpose-grid">
        <label><span>Markdown cleanup</span><select value={markdownFormattingModelId} onChange={(event) => setMarkdownFormattingModelId(event.target.value)}>{customModels.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select></label>
        <label className="processing-toggle"><input type="checkbox" checked={autoFormatMarkdown} onChange={(event) => setAutoFormatMarkdown(event.target.checked)} /><span><strong>Format parsed Markdown automatically</strong><small>Preserves wording, citations, formulas and evidence anchors.</small></span></label>
        <label><span>Full-page OCR</span><select value={fullPageOcrModelId} onChange={(event) => void assignOcrModel(event.target.value)} disabled={busy}><option value="">Disabled</option>{ocrModels.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select></label>
        <div className="ocr-purpose-actions"><label className="processing-toggle"><input type="checkbox" checked={ocrConsent} onChange={(event) => void changeOcrConsent(event.target.checked)} disabled={busy} /><span><strong>Allow encrypted PDF page upload</strong><small>Pages are rendered locally and cached by file hash.</small></span></label><button className="icon-button" onClick={() => void testOcr()} title="Test full-page OCR" disabled={busy || !fullPageOcrModelId || !ocrConsent}><Wifi size={15} /></button></div>
      </div>

      <div className="model-entry-grid">
        <label><span>Display name</span><input value={modelName} onChange={(event) => setModelName(event.target.value)} placeholder="Reasoning" /></label>
        <label><span>Model ID</span><input value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="qwen3.6-plus" /></label>
        <label className="model-url-field"><span>Base URL</span><input list="model-base-url-presets" value={modelBaseUrl} onChange={(event) => setModelBaseUrl(event.target.value)} placeholder="https://gateway.example.com/v1" /><datalist id="model-base-url-presets"><option value={BAILIAN_BEIJING_URL} /></datalist></label>
        <label><span>API format</span><select value={modelFormat} onChange={(event) => setModelFormat(event.target.value as ModelApiFormat)}><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic</option></select></label>
        <label><span>Maximum context tokens</span><input type="number" min={4096} max={2000000} step={1024} value={modelMaxContext} onChange={(event) => setModelMaxContext(Number(event.target.value))} /></label>
        <label className="model-url-field"><span>API key</span><input type="password" value={modelApiKey} onChange={(event) => setModelApiKey(event.target.value)} placeholder="Stored only in Stronghold" autoComplete="off" /></label>
        <div className="model-new-roles"><label><input type="checkbox" checked={assignFormatting} onChange={(event) => setAssignFormatting(event.target.checked)} /> Use for Markdown cleanup</label><label><input type="checkbox" checked={assignOcr} onChange={(event) => setAssignOcr(event.target.checked)} /> Use for full-page OCR</label></div>
        <button className="primary-button compact model-add-button" onClick={() => void addModel()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />} Add model</button>
      </div>
    </section>
    {status && <div className={`settings-status settings-global-status ${status.kind}`} role={status.kind === "error" ? "alert" : "status"}>{status.kind === "error" ? <TriangleAlert size={15} /> : <CheckCircle2 size={15} />}{status.message}</div>}
    <section className="security-facts"><div><span>Python engine</span><strong>No API key access</strong></div><div><span>SQLite & logs</span><strong>Secret redacted</strong></div><div><span>OCR concurrency</span><strong>2 pages</strong></div><div><span>Retry policy</span><strong>2 / 4 / 8 seconds</strong></div></section>
    {nativeRuntime && <section className="settings-section app-management"><div className="settings-heading"><div><h2>Application</h2><p>Remove the desktop app while keeping the independent paper library.</p></div><Trash2 size={18} /></div><button className="danger-button" onClick={uninstall} disabled={busy}><Trash2 size={15} /> Uninstall Papers2Innovations</button></section>}
  </main>;
}
