import { create } from "zustand";

type View = "library" | "jobs" | "import" | "settings";
type ReaderMode = "markdown" | "pdf" | "figures";

interface WorkspaceState {
  root: string;
  selectedPaperId?: string;
  view: View;
  readerMode: ReaderMode;
  query: string;
  statusFilter: "all" | "ready" | "processing" | "issues";
  pdfPage: number;
  setRoot: (root: string) => void;
  selectPaper: (paperId: string) => void;
  setView: (view: View) => void;
  setReaderMode: (mode: ReaderMode) => void;
  setQuery: (query: string) => void;
  setStatusFilter: (filter: WorkspaceState["statusFilter"]) => void;
  openPdfAt: (page: number) => void;
}

const savedRoot = localStorage.getItem("p2i.libraryRoot") ?? "";

export const useWorkspace = create<WorkspaceState>((set) => ({
  root: savedRoot,
  view: "library",
  readerMode: "markdown",
  query: "",
  statusFilter: "all",
  pdfPage: 1,
  setRoot: (root) => {
    localStorage.setItem("p2i.libraryRoot", root);
    set({ root });
  },
  selectPaper: (selectedPaperId) => set({ selectedPaperId, view: "library" }),
  setView: (view) => set({ view }),
  setReaderMode: (readerMode) => set({ readerMode }),
  setQuery: (query) => set({ query }),
  setStatusFilter: (statusFilter) => set({ statusFilter }),
  openPdfAt: (pdfPage) => set({ pdfPage, readerMode: "pdf" }),
}));
