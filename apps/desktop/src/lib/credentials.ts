import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { Stronghold, type Client } from "@tauri-apps/plugin-stronghold";
import { nativeRuntime } from "./bridge";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const clientName = "p2i-settings";
let cachedSummary: OcrCredentialSummary | undefined;
let hydrationPromise: Promise<OcrCredentialSummary> | undefined;

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
