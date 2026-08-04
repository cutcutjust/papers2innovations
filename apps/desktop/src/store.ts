import { create } from "zustand";
import { isTauri } from "@tauri-apps/api/core";
import type { ApiFormat, ModelCapability, ModelConfig, ProviderConfig } from "@p2i/contracts";
import { sanitizeProviderConfig } from "./lib/providerConfig";
import { normalizeFontSize, type FontSize } from "./lib/fontSize";
import type { WorkspaceSettingsSnapshot } from "./lib/settingsSnapshot";
import { modelHasCapability } from "./lib/modelCapabilities";

export type View = "library" | "reader" | "agents" | "context" | "graph" | "innovate" | "jobs" | "import" | "settings" | "security";
type ReaderMode = "markdown" | "pdf" | "figures";
export type LibraryScope = "all" | "favorites" | "recent" | "reading";
export type ModelApiFormat = ApiFormat;
export const CURRENT_ONBOARDING_VERSION = 1;

export const defaultProviders: ProviderConfig[] = [
  { id: "provider-openai-demo", name: "OpenAI-compatible", format: "openai", baseUrl: "https://api.example.com/v1", credentialId: "provider-openai-demo", timeoutSeconds: 90 },
  { id: "provider-anthropic-demo", name: "Anthropic-compatible", format: "anthropic", baseUrl: "https://api.example.com/v1", credentialId: "provider-anthropic-demo", timeoutSeconds: 90 },
];

export const defaultCustomModels: ModelConfig[] = [
  { id: "custom-fast-model", providerId: "provider-openai-demo", displayName: "Fast", model: "custom-fast-model", maxContextTokens: 128000, maxOutputTokens: 4096, capabilities: ["text"] },
  { id: "custom-chat-model", providerId: "provider-openai-demo", displayName: "Chat", model: "custom-chat-model", maxContextTokens: 128000, maxOutputTokens: 4096, capabilities: ["text"] },
  { id: "custom-long-context-model", providerId: "provider-anthropic-demo", displayName: "Long context", model: "custom-long-context-model", maxContextTokens: 200000, maxOutputTokens: 8192, capabilities: ["text"] },
  { id: "custom-reasoning-model", providerId: "provider-openai-demo", displayName: "Reasoning", model: "custom-reasoning-model", maxContextTokens: 128000, maxOutputTokens: 8192, capabilities: ["text"] },
];

const withCapability = (model: ModelConfig, capability: ModelCapability): ModelConfig => ({
  ...model,
  capabilities: Array.from(new Set([...(model.capabilities ?? ["text"]), capability])),
});

export interface WorkspaceState {
  root: string;
  selectedPaperId?: string;
  view: View;
  readerMode: ReaderMode;
  query: string;
  statusFilter: "all" | "ready" | "processing" | "issues";
  libraryScope: LibraryScope;
  selectedCollectionId?: string;
  readerFocusMode: boolean;
  pdfPage: number;
  providers: ProviderConfig[];
  customModels: ModelConfig[];
  defaultTextModelId: string;
  translationModelId: string;
  contextCompressionModelId: string;
  markdownFormattingModelId: string;
  autoFormatMarkdown: boolean;
  fullPageOcrModelId: string;
  visionAnalysisModelId: string;
  ocrConsent: boolean;
  fontSize: FontSize;
  readerZoom: number;
  readerTheme: "white" | "warm" | "green" | "dark" | "custom";
  readerBackgroundColor: string;
  readerTextColor: string;
  readerTranslationView: "original" | "translated";
  readerAnnotationsVisible: boolean;
  onboardingVersion: number;
  importDialogOpen: boolean;
  pendingImportPaths: string[];
  setRoot: (root: string) => void;
  selectPaper: (paperId: string) => void;
  openReader: (paperId?: string) => void;
  setView: (view: View) => void;
  setReaderMode: (mode: ReaderMode) => void;
  setQuery: (query: string) => void;
  setStatusFilter: (filter: WorkspaceState["statusFilter"]) => void;
  setLibraryScope: (scope: LibraryScope) => void;
  setSelectedCollectionId: (collectionId?: string) => void;
  setReaderFocusMode: (enabled: boolean) => void;
  openPdfAt: (page: number) => void;
  addCustomModel: (provider: ProviderConfig, model: ModelConfig) => void;
  updateCustomModel: (modelId: string, patch: Partial<Pick<ModelConfig, "displayName" | "maxContextTokens" | "maxOutputTokens" | "capabilities">>) => void;
  removeCustomModel: (modelId: string) => void;
  setContextCompressionModelId: (modelId: string) => void;
  setDefaultTextModelId: (modelId: string) => void;
  setTranslationModelId: (modelId: string) => void;
  setMarkdownFormattingModelId: (modelId: string) => void;
  setAutoFormatMarkdown: (enabled: boolean) => void;
  setFullPageOcrModelId: (modelId: string) => void;
  setVisionAnalysisModelId: (modelId: string) => void;
  setOcrConsent: (enabled: boolean) => void;
  setFontSize: (size: FontSize) => void;
  setReaderZoom: (zoom: number) => void;
  setReaderTheme: (theme: WorkspaceState["readerTheme"]) => void;
  setReaderColors: (background: string, text: string) => void;
  setReaderTranslationView: (view: WorkspaceState["readerTranslationView"]) => void;
  setReaderAnnotationsVisible: (visible: boolean) => void;
  setOnboardingVersion: (version: number) => void;
  openPaperImport: (paths?: string[]) => void;
  closePaperImport: () => void;
  restoreWorkspaceSettings: (snapshot: WorkspaceSettingsSnapshot) => void;
}

const savedRoot = localStorage.getItem("p2i.libraryRoot") ?? "";
const savedOnboardingVersion = localStorage.getItem("p2i.onboardingVersion");
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
        capabilities: model.capabilities?.length ? model.capabilities : ["text"] as ModelCapability[],
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
        capabilities: ["text"] as ModelCapability[],
      }));
      return { providers: migratedProviders, models: migratedModels };
    }
  } catch {
    // Fall through to non-secret defaults.
  }
  return isTauri() ? { providers: [], models: [] } : { providers: defaultProviders, models: defaultCustomModels };
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
  libraryScope: "all",
  selectedCollectionId: undefined,
  readerFocusMode: false,
  pdfPage: 1,
  providers: initialRegistry.providers,
  customModels: initialRegistry.models,
  defaultTextModelId: localStorage.getItem("p2i.defaultTextModelId") ?? initialRegistry.models.find((model) => modelHasCapability(model, "text"))?.id ?? "",
  translationModelId: localStorage.getItem("p2i.translationModelId") ?? localStorage.getItem("p2i.defaultTextModelId") ?? initialRegistry.models.find((model) => modelHasCapability(model, "text"))?.id ?? "",
  contextCompressionModelId: localStorage.getItem("p2i.contextCompressionModelId") ?? initialRegistry.models[0]?.id ?? "",
  markdownFormattingModelId: localStorage.getItem("p2i.markdownFormattingModelId") ?? initialRegistry.models[0]?.id ?? "",
  autoFormatMarkdown: localStorage.getItem("p2i.autoFormatMarkdown") === "true",
  fullPageOcrModelId: localStorage.getItem("p2i.fullPageOcrModelId") ?? "",
  visionAnalysisModelId: localStorage.getItem("p2i.visionAnalysisModelId") ?? "",
  ocrConsent: localStorage.getItem("p2i.ocrConsent") === "true",
  fontSize: normalizeFontSize(localStorage.getItem("p2i.fontSize")),
  readerZoom: Math.min(180, Math.max(80, Number(localStorage.getItem("p2i.readerZoom")) || 100)),
  readerTheme: (localStorage.getItem("p2i.readerTheme") as WorkspaceState["readerTheme"]) || "white",
  readerBackgroundColor: localStorage.getItem("p2i.readerBackgroundColor") || "#ffffff",
  readerTextColor: localStorage.getItem("p2i.readerTextColor") || "#20242c",
  readerTranslationView: localStorage.getItem("p2i.readerTranslationView") === "translated" ? "translated" : "original",
  readerAnnotationsVisible: localStorage.getItem("p2i.readerAnnotationsVisible") !== "false",
  onboardingVersion: savedOnboardingVersion === null
    ? (isTauri() && !savedRoot ? 0 : CURRENT_ONBOARDING_VERSION)
    : Math.max(0, Number(savedOnboardingVersion) || 0),
  importDialogOpen: false,
  pendingImportPaths: [],
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
  setLibraryScope: (libraryScope) => set({ libraryScope }),
  setSelectedCollectionId: (selectedCollectionId) => set({ selectedCollectionId }),
  setReaderFocusMode: (readerFocusMode) => set({ readerFocusMode }),
  openPdfAt: (pdfPage) => set({ pdfPage, readerMode: "pdf" }),
  addCustomModel: (provider, model) => set((state) => {
    const safeProvider = sanitizeProviderConfig(provider);
    const providers = [...state.providers.filter((item) => item.id !== safeProvider.id), safeProvider];
    const normalizedModel = { ...model, capabilities: model.capabilities?.length ? model.capabilities : ["text"] as ModelCapability[] };
    const customModels = [...state.customModels.filter((item) => item.id !== model.id), normalizedModel];
    persistModelRegistry(providers, customModels);
    const defaultTextModelId = state.defaultTextModelId || (modelHasCapability(normalizedModel, "text") ? normalizedModel.id : "");
    if (defaultTextModelId) localStorage.setItem("p2i.defaultTextModelId", defaultTextModelId);
    const translationModelId = state.translationModelId || defaultTextModelId;
    if (translationModelId) localStorage.setItem("p2i.translationModelId", translationModelId);
    return { providers, customModels, defaultTextModelId, translationModelId };
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
    const defaultTextModelId = state.defaultTextModelId === modelId ? customModels.find((model) => modelHasCapability(model, "text"))?.id ?? "" : state.defaultTextModelId;
    const translationModelId = state.translationModelId === modelId ? defaultTextModelId : state.translationModelId;
    const contextCompressionModelId = state.contextCompressionModelId === modelId ? defaultTextModelId : state.contextCompressionModelId;
    const fullPageOcrModelId = state.fullPageOcrModelId === modelId ? "" : state.fullPageOcrModelId;
    const visionAnalysisModelId = state.visionAnalysisModelId === modelId ? "" : state.visionAnalysisModelId;
    localStorage.setItem("p2i.markdownFormattingModelId", markdownFormattingModelId);
    localStorage.setItem("p2i.defaultTextModelId", defaultTextModelId);
    localStorage.setItem("p2i.translationModelId", translationModelId);
    localStorage.setItem("p2i.contextCompressionModelId", contextCompressionModelId);
    localStorage.setItem("p2i.fullPageOcrModelId", fullPageOcrModelId);
    localStorage.setItem("p2i.visionAnalysisModelId", visionAnalysisModelId);
    return { providers, customModels, defaultTextModelId, translationModelId, contextCompressionModelId, markdownFormattingModelId, fullPageOcrModelId, visionAnalysisModelId };
  }),
  setContextCompressionModelId: (contextCompressionModelId) => {
    localStorage.setItem("p2i.contextCompressionModelId", contextCompressionModelId);
    set({ contextCompressionModelId });
  },
  setDefaultTextModelId: (defaultTextModelId) => set((state) => {
    const customModels = state.customModels.map((model) => model.id === defaultTextModelId ? withCapability(model, "text") : model);
    persistModelRegistry(state.providers, customModels);
    localStorage.setItem("p2i.defaultTextModelId", defaultTextModelId);
    return { defaultTextModelId, customModels };
  }),
  setTranslationModelId: (translationModelId) => {
    localStorage.setItem("p2i.translationModelId", translationModelId);
    set({ translationModelId });
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
  setVisionAnalysisModelId: (visionAnalysisModelId) => set((state) => {
    const customModels = state.customModels.map((model) => model.id === visionAnalysisModelId ? withCapability(model, "vision") : model);
    persistModelRegistry(state.providers, customModels);
    localStorage.setItem("p2i.visionAnalysisModelId", visionAnalysisModelId);
    return { visionAnalysisModelId, customModels };
  }),
  setOcrConsent: (ocrConsent) => {
    localStorage.setItem("p2i.ocrConsent", String(ocrConsent));
    set({ ocrConsent });
  },
  setFontSize: (fontSize) => {
    localStorage.setItem("p2i.fontSize", fontSize);
    set({ fontSize });
  },
  setReaderZoom: (readerZoom) => {
    const normalized = Math.min(180, Math.max(80, Math.round(readerZoom / 5) * 5));
    localStorage.setItem("p2i.readerZoom", String(normalized));
    set({ readerZoom: normalized });
  },
  setReaderTheme: (readerTheme) => {
    localStorage.setItem("p2i.readerTheme", readerTheme);
    set({ readerTheme });
  },
  setReaderColors: (readerBackgroundColor, readerTextColor) => {
    localStorage.setItem("p2i.readerBackgroundColor", readerBackgroundColor);
    localStorage.setItem("p2i.readerTextColor", readerTextColor);
    set({ readerBackgroundColor, readerTextColor, readerTheme: "custom" });
  },
  setReaderTranslationView: (readerTranslationView) => {
    localStorage.setItem("p2i.readerTranslationView", readerTranslationView);
    set({ readerTranslationView });
  },
  setReaderAnnotationsVisible: (readerAnnotationsVisible) => {
    localStorage.setItem("p2i.readerAnnotationsVisible", String(readerAnnotationsVisible));
    set({ readerAnnotationsVisible });
  },
  setOnboardingVersion: (onboardingVersion) => {
    localStorage.setItem("p2i.onboardingVersion", String(onboardingVersion));
    set({ onboardingVersion });
  },
  openPaperImport: (pendingImportPaths = []) => set({ importDialogOpen: true, pendingImportPaths }),
  closePaperImport: () => set({ importDialogOpen: false, pendingImportPaths: [] }),
  restoreWorkspaceSettings: (snapshot) => {
    const providers = snapshot.providers.map(sanitizeProviderConfig);
    const customModels = snapshot.customModels.map((model) => ({ ...model, capabilities: model.capabilities?.length ? model.capabilities : ["text"] as ModelCapability[] }));
    const defaultTextModelId = snapshot.defaultTextModelId
      ?? customModels.find((model) => model.id === snapshot.contextCompressionModelId)?.id
      ?? customModels.find((model) => modelHasCapability(model, "text"))?.id
      ?? "";
    const translationModelId = snapshot.translationModelId
      && customModels.some((model) => model.id === snapshot.translationModelId)
      ? snapshot.translationModelId
      : defaultTextModelId;
    const onboardingVersion = snapshot.onboardingVersion ?? (snapshot.root ? CURRENT_ONBOARDING_VERSION : 0);
    persistModelRegistry(providers, customModels);
    localStorage.setItem("p2i.libraryRoot", snapshot.root);
    localStorage.setItem("p2i.contextCompressionModelId", snapshot.contextCompressionModelId);
    localStorage.setItem("p2i.defaultTextModelId", defaultTextModelId);
    localStorage.setItem("p2i.translationModelId", translationModelId);
    localStorage.setItem("p2i.onboardingVersion", String(onboardingVersion));
    localStorage.setItem("p2i.markdownFormattingModelId", snapshot.markdownFormattingModelId);
    localStorage.setItem("p2i.autoFormatMarkdown", String(snapshot.autoFormatMarkdown));
    localStorage.setItem("p2i.fullPageOcrModelId", snapshot.fullPageOcrModelId);
    localStorage.setItem("p2i.visionAnalysisModelId", snapshot.visionAnalysisModelId ?? "");
    localStorage.setItem("p2i.ocrConsent", String(snapshot.ocrConsent));
    localStorage.setItem("p2i.fontSize", snapshot.fontSize);
    localStorage.setItem("p2i.readerZoom", String(snapshot.readerZoom ?? 100));
    localStorage.setItem("p2i.readerTheme", snapshot.readerTheme ?? "white");
    localStorage.setItem("p2i.readerBackgroundColor", snapshot.readerBackgroundColor ?? "#ffffff");
    localStorage.setItem("p2i.readerTextColor", snapshot.readerTextColor ?? "#20242c");
    localStorage.setItem("p2i.readerTranslationView", snapshot.readerTranslationView ?? "original");
    localStorage.setItem("p2i.readerAnnotationsVisible", String(snapshot.readerAnnotationsVisible ?? true));
    set({
      root: snapshot.root,
      providers,
      customModels,
      defaultTextModelId,
      translationModelId,
      contextCompressionModelId: snapshot.contextCompressionModelId,
      markdownFormattingModelId: snapshot.markdownFormattingModelId,
      autoFormatMarkdown: snapshot.autoFormatMarkdown,
      fullPageOcrModelId: snapshot.fullPageOcrModelId,
      visionAnalysisModelId: snapshot.visionAnalysisModelId ?? "",
      ocrConsent: snapshot.ocrConsent,
      fontSize: snapshot.fontSize,
      readerZoom: snapshot.readerZoom ?? 100,
      readerTheme: snapshot.readerTheme ?? "white",
      readerBackgroundColor: snapshot.readerBackgroundColor ?? "#ffffff",
      readerTextColor: snapshot.readerTextColor ?? "#20242c",
      readerTranslationView: snapshot.readerTranslationView ?? "original",
      readerAnnotationsVisible: snapshot.readerAnnotationsVisible ?? true,
      onboardingVersion,
    });
  },
}));
