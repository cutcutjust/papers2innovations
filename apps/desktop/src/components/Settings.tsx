import { useEffect, useState } from "react";
import { Bot, CheckCircle2, Eye, EyeOff, FileText, LoaderCircle, Plus, ShieldCheck, Trash2, Wifi } from "lucide-react";
import type { CredentialSummary, ProviderConfig } from "@p2i/contracts";
import {
  deleteOcrCredential,
  deleteProviderCredential,
  hydrateOcrCredential,
  hydrateProviderCredentials,
  saveOcrCredential,
  saveProviderCredential,
  testProviderConnection,
  testQwenConnection,
} from "../lib/credentials";
import { nativeRuntime, uninstallApplication } from "../lib/bridge";
import { useWorkspace, type ModelApiFormat } from "../store";

export function Settings() {
  const {
    customModels,
    providers,
    markdownFormattingModelId,
    autoFormatMarkdown,
    addCustomModel,
    updateCustomModel,
    removeCustomModel,
    setMarkdownFormattingModelId,
    setAutoFormatMarkdown,
  } = useWorkspace();
  const [configured, setConfigured] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [consent, setConsent] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [modelName, setModelName] = useState("");
  const [modelId, setModelId] = useState("");
  const [modelBaseUrl, setModelBaseUrl] = useState("");
  const [modelFormat, setModelFormat] = useState<ModelApiFormat>("openai");
  const [modelApiKey, setModelApiKey] = useState("");
  const [modelMaxContext, setModelMaxContext] = useState(128000);
  const [providerSummaries, setProviderSummaries] = useState<Record<string, CredentialSummary>>({});

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setStatus("");
    try {
      await action();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void run(async () => {
      const value = await hydrateOcrCredential();
      setConfigured(value.configured);
      setWorkspaceId(value.workspaceId);
      setBaseUrl(value.baseUrl);
      setConsent(value.consent);
      setStatus(value.configured ? "Stronghold unlocked automatically. Qwen is configured." : "Stronghold is ready. No Qwen credential is stored.");
    });
  }, []);

  useEffect(() => {
    void hydrateProviderCredentials(providers).then((summaries) => {
      setProviderSummaries(Object.fromEntries(summaries.map((item) => [item.credentialId, item])));
    }).catch(() => undefined);
  }, [providers]);

  const save = () => run(async () => {
    if (!apiKey || !consent) throw new Error("API key and page-upload consent are required.");
    const value = await saveOcrCredential({ apiKey, workspaceId, baseUrl, consent });
    setConfigured(value.configured);
    setApiKey("");
    setShowKey(false);
    setStatus("Credential encrypted in Stronghold and loaded into the Rust gateway.");
  });

  const test = () => run(async () => {
    const value = await testQwenConnection();
    if (value.requiresWorkspace) {
      setStatus("This account requires a dedicated business workspace. Add its Workspace ID before enabling OCR.");
      return;
    }
    setStatus(value.ok ? `Connection succeeded (HTTP ${value.status}).` : `Connection failed (HTTP ${value.status}).`);
  });

  const remove = () => run(async () => {
    await deleteOcrCredential();
    setConfigured(false);
    setWorkspaceId("");
    setBaseUrl("");
    setConsent(false);
    setApiKey("");
    setStatus("Credential removed from Stronghold.");
  });

  const uninstall = () => {
    if (!window.confirm("Uninstall Papers2Innovations from this computer? Your paper library will be kept.")) return;
    void run(uninstallApplication);
  };

  const addModel = () => run(async () => {
    const id = modelId.trim();
    if (!id || !modelBaseUrl.trim() || !modelApiKey.trim()) throw new Error("Model ID, Base URL and API key are required.");
    const provider: ProviderConfig = {
      id: `provider-${id}`,
      name: modelName.trim() || id,
      format: modelFormat,
      baseUrl: modelBaseUrl.trim().replace(/\/$/, ""),
      credentialId: `provider-${id}`,
      timeoutSeconds: 90,
    };
    const model = {
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
    setModelName("");
    setModelId("");
    setModelBaseUrl("");
    setModelApiKey("");
    setModelMaxContext(128000);
    setStatus(`Custom model ${id} is available to every AI stage.`);
  });

  const removeModel = (modelIdToRemove: string) => run(async () => {
    const model = customModels.find((item) => item.id === modelIdToRemove);
    const provider = providers.find((item) => item.id === model?.providerId);
    const providerUseCount = customModels.filter((item) => item.providerId === provider?.id).length;
    if (provider && providerUseCount <= 1) await deleteProviderCredential(provider.credentialId);
    removeCustomModel(modelIdToRemove);
    setStatus(`Custom model ${modelIdToRemove} was removed.`);
  });

  const testModel = (modelIdToTest: string) => run(async () => {
    const model = customModels.find((item) => item.id === modelIdToTest);
    const provider = providers.find((item) => item.id === model?.providerId);
    if (!model || !provider) throw new Error("Provider configuration is unavailable.");
    const result = await testProviderConnection(provider, model);
    setStatus(result.ok ? `${model.displayName} connection succeeded (HTTP ${result.status}).` : `${model.displayName} connection failed (HTTP ${result.status}).`);
  });

  return <main className="settings-page">
    <div className="page-title-block"><div className="page-icon"><ShieldCheck size={20} /></div><div><h1>Models & security</h1><p>Manage reusable AI endpoints and full-page OCR credentials.</p></div></div>
    <section className="settings-section model-settings-section">
      <div className="settings-heading"><div><h2>Custom AI models</h2><p>Shared by compression, evidence extraction, idea generation, novelty and critique.</p></div><Bot size={18} /></div>
      <div className="model-registry">
        {customModels.map((model) => {
          const provider = providers.find((item) => item.id === model.providerId);
          const providerConfigured = provider ? providerSummaries[provider.credentialId]?.configured : false;
          return <div className="model-registry-row" key={model.id}>
            <span className="model-format-badge">{provider?.format === "anthropic" ? "Anthropic" : "OpenAI"}</span>
            <span className="model-registry-copy"><strong>{model.displayName}</strong><small>{model.model} / {provider?.baseUrl ?? "Missing provider"} / {providerConfigured ? "Credential stored" : "Needs key"}</small></span>
            <label className="model-context-limit"><span>Context</span><input aria-label={`${model.displayName} maximum context tokens`} type="number" min={4096} max={2000000} step={1024} defaultValue={model.maxContextTokens} onBlur={(event) => { const value = Math.max(4096, Math.min(2_000_000, Number(event.target.value) || 128000)); event.currentTarget.value = String(value); updateCustomModel(model.id, { maxContextTokens: value }); }} /><small>tokens</small></label>
            <button className="icon-button small" onClick={() => void testModel(model.id)} title={`Test ${model.displayName}`} disabled={busy || !providerConfigured}><Wifi size={14} /></button>
            <button className="icon-button small" onClick={() => void removeModel(model.id)} title={`Remove ${model.displayName}`} disabled={busy || customModels.length === 1}><Trash2 size={14} /></button>
          </div>;
        })}
      </div>
      <div className="model-entry-grid">
        <label><span>Display name</span><input value={modelName} onChange={(event) => setModelName(event.target.value)} placeholder="Reasoning" /></label>
        <label><span>Model ID</span><input value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="custom-reasoning-model" /></label>
        <label className="model-url-field"><span>Base URL</span><input value={modelBaseUrl} onChange={(event) => setModelBaseUrl(event.target.value)} placeholder="https://gateway.example.com/v1" /></label>
        <label><span>API format</span><select value={modelFormat} onChange={(event) => setModelFormat(event.target.value as ModelApiFormat)}><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic</option></select></label>
        <label><span>Maximum context tokens</span><input type="number" min={4096} max={2000000} step={1024} value={modelMaxContext} onChange={(event) => setModelMaxContext(Number(event.target.value))} /></label>
        <label className="model-url-field"><span>API key</span><input type="password" value={modelApiKey} onChange={(event) => setModelApiKey(event.target.value)} placeholder="Stored only in Stronghold" autoComplete="off" /></label>
        <button className="primary-button compact model-add-button" onClick={() => void addModel()} disabled={busy}><Plus size={14} /> Add model</button>
      </div>
    </section>
    {status && <div className="settings-status settings-global-status"><CheckCircle2 size={15} /> {status}</div>}
    <section className="settings-section document-processing-section"><div className="settings-heading"><div><h2>Document processing</h2><p>Choose how extracted Markdown is cleaned and configure optional full-page OCR.</p></div><FileText size={18} /></div>
      <div className="document-formatting-controls">
        <label><span>Markdown formatting model</span><select value={markdownFormattingModelId} onChange={(event) => setMarkdownFormattingModelId(event.target.value)}>{customModels.map((model) => <option key={model.id} value={model.id}>{model.displayName} · {(model.maxContextTokens / 1000).toFixed(0)}K context</option>)}</select></label>
        <label className="processing-toggle"><input type="checkbox" checked={autoFormatMarkdown} onChange={(event) => setAutoFormatMarkdown(event.target.checked)} /><span><strong>Automatically format parsed Markdown</strong><small>Runs once per paper and selected model. Formatting preserves wording, citations, formulas and evidence anchors.</small></span></label>
      </div>
      <details className="ocr-settings-inline">
        <summary><span><strong>Full-page OCR</strong><small>qwen3.5-ocr · encrypted credential · Beijing endpoint</small></span><em className={`tag ${configured ? "tag-success" : ""}`}>{configured ? "Configured" : "Optional"}</em></summary>
        <div className="form-grid"><label><span>Workspace ID <small>optional</small></span><input value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} placeholder="Only required for dedicated business spaces" /></label><label><span>Custom Base URL <small>optional</small></span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="Public Beijing endpoint by default" /></label><label className="full-field"><span>OCR API key</span><div className="secret-input"><input type={showKey ? "text" : "password"} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={configured ? "Enter a new key to replace the stored credential" : "sk-..."} autoComplete="off" /><button type="button" onClick={() => setShowKey((value) => !value)} title={showKey ? "Hide key" : "Show key"}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label></div>
        <label className="consent-box"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /><span><strong>Allow PDF pages to be sent to Alibaba Cloud for OCR</strong><small>Each page is rendered locally, cached by hash, and sent only after consent.</small></span></label>
        <div className="settings-actions"><button className="primary-button" onClick={save} disabled={busy || !apiKey || !consent}>{busy ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />} Save securely</button><button className="secondary-button" onClick={test} disabled={busy || !configured}><Wifi size={15} /> Test connection</button><button className="danger-button" onClick={remove} disabled={busy || !configured}><Trash2 size={15} /> Remove</button></div>
      </details>
    </section>
    <section className="security-facts"><div><span>Python engine</span><strong>No API key access</strong></div><div><span>SQLite & logs</span><strong>Secret redacted</strong></div><div><span>Request concurrency</span><strong>2 pages</strong></div><div><span>Retry policy</span><strong>2 / 4 / 8 seconds</strong></div></section>
    {nativeRuntime && <section className="settings-section app-management"><div className="settings-heading"><div><h2>Application</h2><p>Remove the desktop app while keeping the independent paper library.</p></div><Trash2 size={18} /></div><button className="danger-button" onClick={uninstall} disabled={busy}><Trash2 size={15} /> Uninstall Papers2Innovations</button></section>}
  </main>;
}
