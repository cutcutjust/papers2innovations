import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { Stronghold, type Client } from "@tauri-apps/plugin-stronghold";
import type { CredentialSummary, ModelConfig, ProviderConfig } from "@p2i/contracts";
import { nativeRuntime } from "./bridge";
import { sanitizeProviderConfig } from "./providerConfig";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const clientName = "p2i-settings";
let cachedSummary: OcrCredentialSummary | undefined;
let hydrationPromise: Promise<OcrCredentialSummary> | undefined;
const providerSummaryCache = new Map<string, CredentialSummary>();

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
  return invoke("qwen_test_connection");
}

const providerStoreKey = (credentialId: string) => `model-provider:${credentialId}`;

export async function saveProviderCredential(provider: ProviderConfig, apiKey: string): Promise<CredentialSummary> {
  if (!apiKey.trim()) throw new Error("API key is required.");
  const result = { credentialId: provider.credentialId, configured: true };
  if (!nativeRuntime) {
    providerSummaryCache.set(provider.credentialId, result);
    return result;
  }
  const { stronghold, store } = await openStore();
  await store.insert(providerStoreKey(provider.credentialId), Array.from(encoder.encode(apiKey)));
  await stronghold.save();
  await invoke("provider_credential_set", { credentialId: provider.credentialId, apiKey });
  await stronghold.unload();
  providerSummaryCache.set(provider.credentialId, result);
  return result;
}

export async function hydrateProviderCredentials(providers: ProviderConfig[]): Promise<CredentialSummary[]> {
  if (!nativeRuntime) {
    return providers.map((provider) => providerSummaryCache.get(provider.credentialId) ?? { credentialId: provider.credentialId, configured: false });
  }
  if (providers.length === 0) return [];
  const { stronghold, store } = await openStore();
  const summaries: CredentialSummary[] = [];
  for (const provider of providers) {
    const bytes = await store.get(providerStoreKey(provider.credentialId));
    const configured = Boolean(bytes);
    if (bytes) {
      await invoke("provider_credential_set", {
        credentialId: provider.credentialId,
        apiKey: decoder.decode(bytes),
      });
    }
    const item = { credentialId: provider.credentialId, configured };
    providerSummaryCache.set(provider.credentialId, item);
    summaries.push(item);
  }
  await stronghold.unload();
  return summaries;
}

export async function deleteProviderCredential(credentialId: string): Promise<void> {
  providerSummaryCache.delete(credentialId);
  if (!nativeRuntime) return;
  const { stronghold, store } = await openStore();
  await store.remove(providerStoreKey(credentialId));
  await stronghold.save();
  await stronghold.unload();
  await invoke("provider_credential_delete", { credentialId });
}

export async function testProviderConnection(provider: ProviderConfig, model: ModelConfig): Promise<{ ok: boolean; status: number }> {
  if (!nativeRuntime) return { ok: true, status: 200 };
  return invoke("provider_test_connection", { input: { provider: sanitizeProviderConfig(provider), model } });
}
