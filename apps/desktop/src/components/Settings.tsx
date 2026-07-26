import { useEffect, useState } from "react";
import { CheckCircle2, Eye, EyeOff, LoaderCircle, ShieldCheck, Trash2, Wifi } from "lucide-react";
import {
  deleteOcrCredential,
  hydrateOcrCredential,
  saveOcrCredential,
  testQwenConnection,
} from "../lib/credentials";
import { nativeRuntime, uninstallApplication } from "../lib/bridge";

export function Settings() {
  const [configured, setConfigured] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [consent, setConsent] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

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

  return <main className="settings-page">
    <div className="page-title-block"><div className="page-icon"><ShieldCheck size={20} /></div><div><h1>OCR & security</h1><p>Configure full-page Qwen OCR through the Rust model gateway.</p></div></div>
    <section className="settings-section"><div className="settings-heading"><div><h2>Stronghold vault</h2><p>Automatically unlocked with a random key held by the operating system credential store.</p></div><ShieldCheck size={18} /></div><div className="vault-state"><span>{configured ? "Qwen credential stored" : "Vault ready"}</span><strong>{configured ? "Configured" : "Not configured"}</strong></div></section>
    <section className="settings-section"><div className="settings-heading"><div><h2>Alibaba Cloud Model Studio</h2><p>Beijing region | OpenAI-compatible API | qwen3.5-ocr</p></div><Wifi size={18} /></div>
      <div className="form-grid"><label><span>Workspace ID <small>optional</small></span><input value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} placeholder="Only required for dedicated business spaces" /></label><label><span>Custom Base URL <small>optional</small></span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="Public Beijing endpoint by default" /></label><label className="full-field"><span>DashScope API key</span><div className="secret-input"><input type={showKey ? "text" : "password"} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={configured ? "Enter a new key to replace the stored credential" : "sk-..."} autoComplete="off" /><button type="button" onClick={() => setShowKey((value) => !value)} title={showKey ? "Hide key" : "Show key"}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label></div>
      <label className="consent-box"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /><span><strong>Allow all PDF pages to be sent to Alibaba Cloud for OCR</strong><small>Each page is rendered locally, cached by hash, and sent only after consent.</small></span></label>
      <div className="settings-actions"><button className="primary-button" onClick={save} disabled={busy || !apiKey || !consent}>{busy ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />} Save securely</button><button className="secondary-button" onClick={test} disabled={busy || !configured}><Wifi size={15} /> Test connection</button><button className="danger-button" onClick={remove} disabled={busy || !configured}><Trash2 size={15} /> Remove</button></div>
      {status && <div className="settings-status"><CheckCircle2 size={15} /> {status}</div>}
    </section>
    <section className="security-facts"><div><span>Python engine</span><strong>No API key access</strong></div><div><span>SQLite & logs</span><strong>Secret redacted</strong></div><div><span>Request concurrency</span><strong>2 pages</strong></div><div><span>Retry policy</span><strong>2 / 4 / 8 seconds</strong></div></section>
    {nativeRuntime && <section className="settings-section app-management"><div className="settings-heading"><div><h2>Application</h2><p>Remove the desktop app while keeping the independent paper library.</p></div><Trash2 size={18} /></div><button className="danger-button" onClick={uninstall} disabled={busy}><Trash2 size={15} /> Uninstall Papers2Innovations</button></section>}
  </main>;
}
