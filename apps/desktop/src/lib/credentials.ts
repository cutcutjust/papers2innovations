import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { Stronghold, type Client } from "@tauri-apps/plugin-stronghold";
import type { CredentialSummary, ModelConfig, ProviderConfig } from "@p2i/contracts";
import { nativeRuntime } from "./bridge";
import { sanitizeProviderConfig } from "./providerConfig";
import { applyModelStreamEvent, beginModelActivity, completeModelActivity, failModelActivity } from "./modelActivity";
import { isWorkspaceSettingsSnapshot, type WorkspaceSettingsSnapshot } from "./settingsSnapshot";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const clientName = "p2i-settings";
let cachedSummary: OcrCredentialSummary | undefined;
let hydrationPromise: Promise<OcrCredentialSummary> | undefined;
const providerSummaryCache = new Map<string, CredentialSummary>();
const settingsSnapshotKey = "workspace-settings:v1";
const credentialIndexKey = "provider-credential-index:v1";

async function openStore() {
  const vaultPath = await join(await appDataDir(), "p2i-vault.hold");
  const password = await invoke<string>("stronghold_password");
  const stronghold = await Stronghold.load(vaultPath, password);
  let client: Client;
  try {
    client = await stronghold.loadClient(clientName);
  } catch {
    client = await stronghold.createClient(clientName);
  }
  return { stronghold, store: client.getStore() };
}

export interface OcrCredential {
  apiKey: string;
  workspaceId: string;
  baseUrl: string;
  consent: boolean;
}

export interface OcrCredentialSummary {
  configured: boolean;
  workspaceId: string;
  baseUrl: string;
  consent: boolean;
}

function summary(credential: OcrCredential): OcrCredentialSummary {
  return {
    configured: true,
    workspaceId: credential.workspaceId,
    baseUrl: credential.baseUrl,
    consent: credential.consent,
  };
}

export async function saveOcrCredential(credential: OcrCredential): Promise<OcrCredentialSummary> {
  if (!nativeRuntime) return summary(credential);
  const { stronghold, store } = await openStore();
  await store.insert("qwen-ocr", Array.from(encoder.encode(JSON.stringify(credential))));
  await stronghold.save();
  await invoke("credential_set", {
    input: {
      apiKey: credential.apiKey,
      workspaceId: credential.workspaceId || null,
      baseUrl: credential.baseUrl || null,
      consent: credential.consent,
    },
  });
  await stronghold.unload();
  cachedSummary = summary(credential);
  return cachedSummary;
}

async function hydrateFromStronghold(): Promise<OcrCredentialSummary> {
  if (!nativeRuntime) {
    return { configured: false, workspaceId: "", baseUrl: "", consent: false };
  }
  const { stronghold, store } = await openStore();
  const bytes = await store.get("qwen-ocr");
  if (!bytes) {
    await stronghold.unload();
    return { configured: false, workspaceId: "", baseUrl: "", consent: false };
  }
  const credential = JSON.parse(decoder.decode(bytes)) as OcrCredential;
  await invoke("credential_set", {
    input: {
      apiKey: credential.apiKey,
      workspaceId: credential.workspaceId || null,
      baseUrl: credential.baseUrl || null,
      consent: credential.consent,
    },
  });
  await stronghold.unload();
  return summary(credential);
}

export async function hydrateOcrCredential(): Promise<OcrCredentialSummary> {
  if (cachedSummary) return cachedSummary;
  if (!hydrationPromise) {
    hydrationPromise = hydrateFromStronghold()
      .then((value) => {
        cachedSummary = value;
        return value;
      })
      .finally(() => {
        hydrationPromise = undefined;
      });
  }
  return hydrationPromise;
}

export async function deleteOcrCredential(): Promise<void> {
  if (!nativeRuntime) return;
  const { stronghold, store } = await openStore();
  await store.remove("qwen-ocr");
  await stronghold.save();
  await stronghold.unload();
  await invoke("credential_delete");
  cachedSummary = { configured: false, workspaceId: "", baseUrl: "", consent: false };
}

export async function testQwenConnection(): Promise<{
  ok: boolean;
  status: number;
  requiresWorkspace: boolean;
}> {
  if (!nativeRuntime) return { ok: true, status: 200, requiresWorkspace: false };
  const requestId = crypto.randomUUID();
  beginModelActivity(requestId, { source: "connection-test", label: "测试全文 OCR 接口", modelName: "全文 OCR" });
  applyModelStreamEvent({ requestId, kind: "started" });
  try {
    const result = await invoke<{ ok: boolean; status: number; requiresWorkspace: boolean }>("qwen_test_connection");
    if (result.ok) completeModelActivity(requestId);
    else failModelActivity(requestId, `OCR 接口返回 HTTP ${result.status}`);
    return result;
  } catch (error) {
    failModelActivity(requestId, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function configureOcrProvider(provider: ProviderConfig, model: ModelConfig, consent: boolean): Promise<void> {
  if (!nativeRuntime) return;
  await invoke("ocr_provider_configure", {
    input: { provider: sanitizeProviderConfig(provider), model, consent },
  });
}

export async function configureVisionProvider(provider: ProviderConfig, model: ModelConfig): Promise<void> {
  if (!nativeRuntime) return;
  await invoke("vision_provider_configure", {
    input: { provider: sanitizeProviderConfig(provider), model },
  });
}

export async function clearVisionProvider(): Promise<void> {
  if (!nativeRuntime) return;
  await invoke("vision_provider_clear");
}

export async function clearOcrProvider(): Promise<void> {
  if (!nativeRuntime) return;
  await invoke("credential_delete");
}

const providerStoreKey = (credentialId: string) => `model-provider:${credentialId}`;

export function providerRecoveryId(provider: ProviderConfig): string {
  const value = `${provider.format}|${provider.baseUrl.trim().replace(/\/+$/, "").toLowerCase()}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `provider-recovery-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

async function readCredentialIndex(store: ReturnType<Client["getStore"]>): Promise<Record<string, string>> {
  const bytes = await store.get(credentialIndexKey);
  if (!bytes) return {};
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    if (!value || typeof value !== "object") return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

async function historicalProviders(store: ReturnType<Client["getStore"]>): Promise<ProviderConfig[]> {
  const bytes = await store.get(settingsSnapshotKey);
  if (!bytes) return [];
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    return isWorkspaceSettingsSnapshot(value) ? value.providers.map(sanitizeProviderConfig) : [];
  } catch {
    return [];
  }
}

export async function saveProviderCredential(provider: ProviderConfig, apiKey: string): Promise<CredentialSummary> {
  if (!apiKey.trim()) throw new Error("API key is required.");
  const result = { credentialId: provider.credentialId, configured: true };
  if (!nativeRuntime) {
    providerSummaryCache.set(provider.credentialId, result);
    return result;
  }
  const { stronghold, store } = await openStore();
  try {
    await store.insert(providerStoreKey(provider.credentialId), Array.from(encoder.encode(apiKey)));
    const index = await readCredentialIndex(store);
    index[providerRecoveryId(provider)] = provider.credentialId;
    await store.insert(credentialIndexKey, Array.from(encoder.encode(JSON.stringify(index))));
    await stronghold.save();
    await invoke("provider_credential_set", { credentialId: provider.credentialId, apiKey });
  } finally {
    await stronghold.unload();
  }
  providerSummaryCache.set(provider.credentialId, result);
  return result;
}

export async function hydrateProviderCredentials(providers: ProviderConfig[]): Promise<CredentialSummary[]> {
  if (!nativeRuntime) {
    return providers.map((provider) => providerSummaryCache.get(provider.credentialId) ?? { credentialId: provider.credentialId, configured: false });
  }
  if (providers.length === 0) return [];
  const { stronghold, store } = await openStore();
  try {
    const summaries: CredentialSummary[] = [];
    const index = await readCredentialIndex(store);
    const previousProviders = await historicalProviders(store);
    let vaultChanged = false;
    for (const provider of providers) {
      const recoveryId = providerRecoveryId(provider);
      const priorMatches = previousProviders
        .filter((candidate) => providerRecoveryId(candidate) === recoveryId)
        .flatMap((candidate) => [candidate.credentialId, candidate.id]);
      const candidateIds = [...new Set([
        provider.credentialId,
        provider.id,
        index[recoveryId],
        recoveryId,
        ...priorMatches,
      ].filter((value): value is string => Boolean(value)))];
      let configured = false;
      for (const candidateId of candidateIds) {
        const bytes = await store.get(providerStoreKey(candidateId));
        if (!bytes) continue;
        const apiKey = decoder.decode(bytes);
        await invoke("provider_credential_set", { credentialId: provider.credentialId, apiKey });
        if (candidateId !== provider.credentialId) {
          await store.insert(providerStoreKey(provider.credentialId), Array.from(bytes));
          vaultChanged = true;
        }
        configured = true;
        break;
      }
      if (!configured) {
        for (const candidateId of candidateIds) {
          const restored = await invoke<boolean>("provider_credential_restore", {
            credentialId: candidateId,
            targetCredentialId: provider.credentialId,
          }).catch(() => false);
          if (restored) {
            configured = true;
            break;
          }
        }
      }
      if (configured && index[recoveryId] !== provider.credentialId) {
        index[recoveryId] = provider.credentialId;
        vaultChanged = true;
      }
      const item = { credentialId: provider.credentialId, configured };
      providerSummaryCache.set(provider.credentialId, item);
      summaries.push(item);
    }
    if (vaultChanged) {
      await store.insert(credentialIndexKey, Array.from(encoder.encode(JSON.stringify(index))));
      await stronghold.save();
    }
    return summaries;
  } finally {
    await stronghold.unload();
  }
}

export async function deleteProviderCredential(credentialId: string): Promise<void> {
  providerSummaryCache.delete(credentialId);
  if (!nativeRuntime) return;
  const { stronghold, store } = await openStore();
  try {
    await store.remove(providerStoreKey(credentialId));
    const index = await readCredentialIndex(store);
    const nextIndex = Object.fromEntries(Object.entries(index).filter(([, value]) => value !== credentialId));
    await store.insert(credentialIndexKey, Array.from(encoder.encode(JSON.stringify(nextIndex))));
    await stronghold.save();
    await invoke("provider_credential_delete", { credentialId });
  } finally {
    await stronghold.unload();
  }
}

export async function testProviderConnection(provider: ProviderConfig, model: ModelConfig): Promise<{ ok: boolean; status: number }> {
  if (!nativeRuntime) return { ok: true, status: 200 };
  const requestId = crypto.randomUUID();
  beginModelActivity(requestId, { source: "connection-test", label: `测试 ${model.displayName}`, modelName: model.displayName });
  applyModelStreamEvent({ requestId, kind: "started" });
  try {
    const result = await invoke<{ ok: boolean; status: number }>("provider_test_connection", { input: { provider: sanitizeProviderConfig(provider), model } });
    if (result.ok) completeModelActivity(requestId);
    else failModelActivity(requestId, `${model.displayName} 返回 HTTP ${result.status}`);
    return result;
  } catch (error) {
    failModelActivity(requestId, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function loadWorkspaceSettingsSnapshot(): Promise<WorkspaceSettingsSnapshot | null> {
  if (!nativeRuntime) return null;
  const { stronghold, store } = await openStore();
  try {
    const bytes = await store.get(settingsSnapshotKey);
    if (!bytes) return null;
    const value: unknown = JSON.parse(decoder.decode(bytes));
    return isWorkspaceSettingsSnapshot(value) ? value : null;
  } finally {
    await stronghold.unload();
  }
}

export async function saveWorkspaceSettingsSnapshot(snapshot: WorkspaceSettingsSnapshot): Promise<void> {
  if (!nativeRuntime) return;
  const { stronghold, store } = await openStore();
  try {
    await store.insert(settingsSnapshotKey, Array.from(encoder.encode(JSON.stringify(snapshot))));
    await stronghold.save();
  } finally {
    await stronghold.unload();
  }
}
