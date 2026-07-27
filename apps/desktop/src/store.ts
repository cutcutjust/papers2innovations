import { create } from "zustand";

export type View = "library" | "reader" | "agents" | "context" | "graph" | "innovate" | "jobs" | "import" | "settings";
type ReaderMode = "markdown" | "pdf" | "figures";

export type ModelApiFormat = "openai" | "anthropic";

export interface CustomModelConfig {
  id: string;
  name: string;
  model: string;
  baseUrl: string;
  format: ModelApiFormat;
}

export const defaultCustomModels: CustomModelConfig[] = [
  { id: "custom-fast-model", name: "Fast", model: "custom-fast-model", baseUrl: "https://api.example.com/v1", format: "openai" },
  { id: "custom-chat-model", name: "Chat", model: "custom-chat-model", baseUrl: "https://api.example.com/v1", format: "openai" },
  { id: "custom-long-context-model", name: "Long context", model: "custom-long-context-model", baseUrl: "https://api.example.com", format: "anthropic" },
  { id: "custom-reasoning-model", name: "Reasoning", model: "custom-reasoning-model", baseUrl: "https://api.example.com/v1", format: "openai" },
];

interface WorkspaceState {
  root: string;
  selectedPaperId?: string;
  view: View;
  readerMode: ReaderMode;
  query: string;
  statusFilter: "all" | "ready" | "processing" | "issues";
  pdfPage: number;
  customModels: CustomModelConfig[];
  setRoot: (root: string) => void;
  selectPaper: (paperId: string) => void;
  openReader: (paperId?: string) => void;
  setView: (view: View) => void;
  setReaderMode: (mode: ReaderMode) => void;
  setQuery: (query: string) => void;
  setStatusFilter: (filter: WorkspaceState["statusFilter"]) => void;
  openPdfAt: (page: number) => void;
  addCustomModel: (model: CustomModelConfig) => void;
  removeCustomModel: (modelId: string) => void;
}

const savedRoot = localStorage.getItem("p2i.libraryRoot") ?? "";
const loadCustomModels = () => {
  try {
    const value = JSON.parse(localStorage.getItem("p2i.customModels") ?? "null");
    return Array.isArray(value) && value.length > 0 ? value as CustomModelConfig[] : defaultCustomModels;
  } catch {
    return defaultCustomModels;
  }
};

export const useWorkspace = create<WorkspaceState>((set) => ({
  root: savedRoot,
  view: "library",
  readerMode: "markdown",
  query: "",
  statusFilter: "all",
  pdfPage: 1,
  customModels: loadCustomModels(),
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
  addCustomModel: (model) => set((state) => {
    const customModels = [...state.customModels.filter((item) => item.id !== model.id), model];
    localStorage.setItem("p2i.customModels", JSON.stringify(customModels));
    return { customModels };
  }),
  removeCustomModel: (modelId) => set((state) => {
    const customModels = state.customModels.filter((model) => model.id !== modelId);
    localStorage.setItem("p2i.customModels", JSON.stringify(customModels));
    return { customModels };
  }),
}));
