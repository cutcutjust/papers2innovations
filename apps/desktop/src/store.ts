import { create } from "zustand";
import type { ApiFormat, ModelConfig, ProviderConfig } from "@p2i/contracts";
import { sanitizeProviderConfig } from "./lib/providerConfig";
import { normalizeFontSize, type FontSize } from "./lib/fontSize";
import type { WorkspaceSettingsSnapshot } from "./lib/settingsSnapshot";

export type View = "library" | "reader" | "agents" | "context" | "graph" | "innovate" | "jobs" | "import" | "settings" | "security";
type ReaderMode = "markdown" | "pdf" | "figures";
export type ModelApiFormat = ApiFormat;

export const defaultProviders: ProviderConfig[] = [
  { id: "provider-openai-demo", name: "OpenAI-compatible", format: "openai", baseUrl: "https://api.example.com/v1", credentialId: "provider-openai-demo", timeoutSeconds: 90 },
  { id: "provider-anthropic-demo", name: "Anthropic-compatible", format: "anthropic", baseUrl: "https://api.example.com/v1", credentialId: "provider-anthropic-demo", timeoutSeconds: 90 },
];

export const defaultCustomModels: ModelConfig[] = [
  { id: "custom-fast-model", providerId: "provider-openai-demo", displayName: "Fast", model: "custom-fast-model", maxContextTokens: 128000, maxOutputTokens: 4096 },
  { id: "custom-chat-model", providerId: "provider-openai-demo", displayName: "Chat", model: "custom-chat-model", maxContextTokens: 128000, maxOutputTokens: 4096 },
  { id: "custom-long-context-model", providerId: "provider-anthropic-demo", displayName: "Long context", model: "custom-long-context-model", maxContextTokens: 200000, maxOutputTokens: 8192 },
  { id: "custom-reasoning-model", providerId: "provider-openai-demo", displayName: "Reasoning", model: "custom-reasoning-model", maxContextTokens: 128000, maxOutputTokens: 8192 },
];

export interface WorkspaceState {
  root: string;
  selectedPaperId?: string;
  view: View;
  readerMode: ReaderMode;
  query: string;
  statusFilter: "all" | "ready" | "processing" | "issues";
  pdfPage: number;
  providers: ProviderConfig[];
  customModels: ModelConfig[];
  contextCompressionModelId: string;
  markdownFormattingModelId: string;
  autoFormatMarkdown: boolean;
  fullPageOcrModelId: string;
  ocrConsent: boolean;
  fontSize: FontSize;
  setRoot: (root: string) => void;
  selectPaper: (paperId: string) => void;
  openReader: (paperId?: string) => void;
  setView: (view: View) => void;
  setReaderMode: (mode: ReaderMode) => void;
  setQuery: (query: string) => void;
  setStatusFilter: (filter: WorkspaceState["statusFilter"]) => void;
  openPdfAt: (page: number) => void;
  addCustomModel: (provider: ProviderConfig, model: ModelConfig) => void;
  updateCustomModel: (modelId: string, patch: Partial<Pick<ModelConfig, "displayName" | "maxContextTokens" | "maxOutputTokens">>) => void;
  removeCustomModel: (modelId: string) => void;
  setContextCompressionModelId: (modelId: string) => void;
  setMarkdownFormattingModelId: (modelId: string) => void;
  setAutoFormatMarkdown: (enabled: boolean) => void;
  setFullPageOcrModelId: (modelId: string) => void;
  setOcrConsent: (enabled: boolean) => void;
  setFontSize: (size: FontSize) => void;
  restoreWorkspaceSettings: (snapshot: WorkspaceSettingsSnapshot) => void;
}

const savedRoot = localStorage.getItem("p2i.libraryRoot") ?? "";
export const hasPersistedWorkspaceSettings = Boolean(
  localStorage.getItem("p2i.providers") || localStorage.getItem("p2i.models") || localStorage.getItem("p2i.libraryRoot"),
);
const loadModelRegistry = (): { providers: ProviderConfig[]; models: ModelConfig[] } => {
  try {
    const providers = JSON.parse(localStorage.getItem("p2i.providers") ?? "null");
    const models = JSON.parse(localStorage.getItem("p2i.models") ?? "null");
    if (Array.isArray(providers) && providers.length > 0 && Array.isArray(models) && models.length > 0) {
      const safeProviders = (providers as ProviderConfig[]).map(sanitizeProviderConfig);
      if (JSON.stringify(safeProviders) !== JSON.stringify(providers)) {
        localStorage.setItem("p2i.providers", JSON.stringify(safeProviders));
      }
      const safeModels = (models as ModelConfig[]).map((model) => ({
        ...model,
        maxContextTokens: Number.isFinite(model.maxContextTokens) && model.maxContextTokens >= 4096 ? model.maxContextTokens : 128000,
        maxOutputTokens: Number.isFinite(model.maxOutputTokens) && model.maxOutputTokens >= 256 ? model.maxOutputTokens : 4096,
      }));
      return { providers: safeProviders, models: safeModels };
    }
    const legacy = JSON.parse(localStorage.getItem("p2i.customModels") ?? "null") as Array<Record<string, string>> | null;
    if (Array.isArray(legacy) && legacy.length > 0) {
      const migratedProviders = legacy.map((item) => ({
        id: `provider-${item.id}`,
        name: item.name || item.id,
        format: (item.format === "anthropic" ? "anthropic" : "openai") as ApiFormat,
        baseUrl: item.baseUrl,
        credentialId: `provider-${item.id}`,
        timeoutSeconds: 90,
      }));
      const migratedModels = legacy.map((item) => ({
        id: item.id,
        providerId: `provider-${item.id}`,
        model: item.model || item.id,
        displayName: item.name || item.id,
        maxContextTokens: 128000,
        maxOutputTokens: 4096,
      }));
      return { providers: migratedProviders, models: migratedModels };
    }
  } catch {
    // Fall through to non-secret defaults.
  }
  return { providers: defaultProviders, models: defaultCustomModels };
};

const initialRegistry = loadModelRegistry();
const persistModelRegistry = (providers: ProviderConfig[], models: ModelConfig[]) => {
  localStorage.setItem("p2i.providers", JSON.stringify(providers.map(sanitizeProviderConfig)));
  localStorage.setItem("p2i.models", JSON.stringify(models));
  localStorage.removeItem("p2i.customModels");
};

export const useWorkspace = create<WorkspaceState>((set) => ({
  root: savedRoot,
  view: "library",
  readerMode: "markdown",
  query: "",
  statusFilter: "all",
  pdfPage: 1,
  providers: initialRegistry.providers,
  customModels: initialRegistry.models,
  contextCompressionModelId: localStorage.getItem("p2i.contextCompressionModelId") ?? initialRegistry.models[0]?.id ?? "",
  markdownFormattingModelId: localStorage.getItem("p2i.markdownFormattingModelId") ?? initialRegistry.models[0]?.id ?? "",
  autoFormatMarkdown: localStorage.getItem("p2i.autoFormatMarkdown") === "true",
  fullPageOcrModelId: localStorage.getItem("p2i.fullPageOcrModelId") ?? "",
  ocrConsent: localStorage.getItem("p2i.ocrConsent") === "true",
  fontSize: normalizeFontSize(localStorage.getItem("p2i.fontSize")),
  setRoot: (root) => {
    localStorage.setItem("p2i.libraryRoot", root);
    set({ root });
  },
  selectPaper: (selectedPaperId) => set({ selectedPaperId }),
  openReader: (selectedPaperId) => set((state) => ({ selectedPaperId: selectedPaperId ?? state.selectedPaperId, view: "reader" })),
  setView: (view) => set({ view }),
  setReaderMode: (readerMode) => set({ readerMode }),
  setQuery: (query) => set({ query }),
  setStatusFilter: (statusFilter) => set({ statusFilter }),
  openPdfAt: (pdfPage) => set({ pdfPage, readerMode: "pdf" }),
  addCustomModel: (provider, model) => set((state) => {
    const safeProvider = sanitizeProviderConfig(provider);
    const providers = [...state.providers.filter((item) => item.id !== safeProvider.id), safeProvider];
    const customModels = [...state.customModels.filter((item) => item.id !== model.id), model];
    persistModelRegistry(providers, customModels);
    return { providers, customModels };
  }),
  updateCustomModel: (modelId, patch) => set((state) => {
    const customModels = state.customModels.map((model) => model.id === modelId ? { ...model, ...patch } : model);
    persistModelRegistry(state.providers, customModels);
    return { customModels };
  }),
  removeCustomModel: (modelId) => set((state) => {
    const customModels = state.customModels.filter((model) => model.id !== modelId);
    const usedProviders = new Set(customModels.map((model) => model.providerId));
    const providers = state.providers.filter((provider) => usedProviders.has(provider.id));
    persistModelRegistry(providers, customModels);
    const markdownFormattingModelId = state.markdownFormattingModelId === modelId ? customModels[0]?.id ?? "" : state.markdownFormattingModelId;
    const fullPageOcrModelId = state.fullPageOcrModelId === modelId ? "" : state.fullPageOcrModelId;
    localStorage.setItem("p2i.markdownFormattingModelId", markdownFormattingModelId);
    localStorage.setItem("p2i.fullPageOcrModelId", fullPageOcrModelId);
    return { providers, customModels, markdownFormattingModelId, fullPageOcrModelId };
  }),
  setContextCompressionModelId: (contextCompressionModelId) => {
    localStorage.setItem("p2i.contextCompressionModelId", contextCompressionModelId);
    set({ contextCompressionModelId });
  },
  setMarkdownFormattingModelId: (markdownFormattingModelId) => {
    localStorage.setItem("p2i.markdownFormattingModelId", markdownFormattingModelId);
    set({ markdownFormattingModelId });
  },
  setAutoFormatMarkdown: (autoFormatMarkdown) => {
    localStorage.setItem("p2i.autoFormatMarkdown", String(autoFormatMarkdown));
    set({ autoFormatMarkdown });
  },
  setFullPageOcrModelId: (fullPageOcrModelId) => {
    localStorage.setItem("p2i.fullPageOcrModelId", fullPageOcrModelId);
    set({ fullPageOcrModelId });
  },
  setOcrConsent: (ocrConsent) => {
    localStorage.setItem("p2i.ocrConsent", String(ocrConsent));
    set({ ocrConsent });
  },
  setFontSize: (fontSize) => {
    localStorage.setItem("p2i.fontSize", fontSize);
    set({ fontSize });
  },
  restoreWorkspaceSettings: (snapshot) => {
    const providers = snapshot.providers.map(sanitizeProviderConfig);
    const customModels = snapshot.customModels;
    persistModelRegistry(providers, customModels);
    localStorage.setItem("p2i.libraryRoot", snapshot.root);
    localStorage.setItem("p2i.contextCompressionModelId", snapshot.contextCompressionModelId);
    localStorage.setItem("p2i.markdownFormattingModelId", snapshot.markdownFormattingModelId);
    localStorage.setItem("p2i.autoFormatMarkdown", String(snapshot.autoFormatMarkdown));
    localStorage.setItem("p2i.fullPageOcrModelId", snapshot.fullPageOcrModelId);
    localStorage.setItem("p2i.ocrConsent", String(snapshot.ocrConsent));
    localStorage.setItem("p2i.fontSize", snapshot.fontSize);
    set({
      root: snapshot.root,
      providers,
      customModels,
      contextCompressionModelId: snapshot.contextCompressionModelId,
      markdownFormattingModelId: snapshot.markdownFormattingModelId,
      autoFormatMarkdown: snapshot.autoFormatMarkdown,
      fullPageOcrModelId: snapshot.fullPageOcrModelId,
      ocrConsent: snapshot.ocrConsent,
      fontSize: snapshot.fontSize,
    });
  },
}));
