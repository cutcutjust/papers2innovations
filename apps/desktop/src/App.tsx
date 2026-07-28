import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen } from "lucide-react";
import { AppUpdater } from "./components/AppUpdater";
import { Activity } from "./components/Activity";
import { Settings } from "./components/Settings";
import { SecuritySettings } from "./components/SecuritySettings";
import { ZoteroImport } from "./components/ZoteroImport";
import { InnovationWorkspace } from "./components/InnovationWorkspace";
import { Reader } from "./components/Reader";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { LibraryStartup } from "./components/LibraryStartup";
import { LibraryWorkspace } from "./components/LibraryWorkspace";
import { PromptLibrary } from "./components/PromptLibrary";
import { ContextWorkspace } from "./components/ContextWorkspace";
import { CitationGraph } from "./components/CitationGraph";
import { chooseLibrary, initializeLibrary, listCollections, listJobs, listPapers, nativeRuntime, onEngineProgress, scanLibrary, startLibraryWatcher } from "./lib/bridge";
import { clearVisionProvider, configureVisionProvider, hydrateOcrCredential, hydrateProviderCredentials, loadWorkspaceSettingsSnapshot, saveWorkspaceSettingsSnapshot } from "./lib/credentials";
import { filterPapersByCollection } from "./lib/collectionTree";
import { hasPersistedWorkspaceSettings, useWorkspace } from "./store";

export function App() {
  const workspace = useWorkspace();
  const queryClient = useQueryClient();
  const settingsRecoveryStarted = useRef(false);
  const [settingsRecovered, setSettingsRecovered] = useState(!nativeRuntime);
  const defaultRoot = nativeRuntime ? "E:/Papers2Innovations-Library" : "D:/Research/Papers2Innovations-Library";
  const root = workspace.root || defaultRoot;
  const papersQuery = useQuery({
    queryKey: ["papers", root],
    queryFn: async () => {
      await initializeLibrary(root);
      return listPapers(root);
    },
    enabled: Boolean(root),
    refetchInterval: nativeRuntime ? 10_000 : false,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const scanMutation = useMutation({
    mutationFn: () => scanLibrary(root),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["papers", root] }),
  });
  const collectionsQuery = useQuery({
    queryKey: ["collections", root],
    queryFn: async () => {
      await initializeLibrary(root);
      return listCollections(root);
    },
    enabled: Boolean(root),
    refetchOnWindowFocus: false,
    retry: false,
  });
  const jobsQuery = useQuery({
    queryKey: ["jobs", root],
    queryFn: () => listJobs(root),
    enabled: Boolean(root && workspace.view === "jobs"),
    refetchInterval: 4_000,
    retry: false,
  });

  useEffect(() => {
    if (!workspace.root) workspace.setRoot(root);
  }, [root, workspace]);

  useEffect(() => {
    if (!nativeRuntime || settingsRecoveryStarted.current) return;
    settingsRecoveryStarted.current = true;
    void loadWorkspaceSettingsSnapshot()
      .then((snapshot) => {
        if (snapshot && !hasPersistedWorkspaceSettings) workspace.restoreWorkspaceSettings(snapshot);
      })
      .then(async () => {
        const providers = useWorkspace.getState().providers;
        await hydrateOcrCredential().catch(() => undefined);
        await hydrateProviderCredentials(providers).catch(() => undefined);
      })
      .finally(() => setSettingsRecovered(true));
  }, []);

  useEffect(() => {
    if (!nativeRuntime || !settingsRecovered) return;
    void saveWorkspaceSettingsSnapshot({
      version: 2,
      root: workspace.root,
      providers: workspace.providers,
      customModels: workspace.customModels,
      contextCompressionModelId: workspace.contextCompressionModelId,
      markdownFormattingModelId: workspace.markdownFormattingModelId,
      autoFormatMarkdown: workspace.autoFormatMarkdown,
      fullPageOcrModelId: workspace.fullPageOcrModelId,
      visionAnalysisModelId: workspace.visionAnalysisModelId,
      ocrConsent: workspace.ocrConsent,
      fontSize: workspace.fontSize,
      readerZoom: workspace.readerZoom,
      readerTheme: workspace.readerTheme,
      readerBackgroundColor: workspace.readerBackgroundColor,
      readerTextColor: workspace.readerTextColor,
      readerTranslationView: workspace.readerTranslationView,
    }).catch(() => undefined);
  }, [settingsRecovered, workspace.root, workspace.providers, workspace.customModels, workspace.contextCompressionModelId, workspace.markdownFormattingModelId, workspace.autoFormatMarkdown, workspace.fullPageOcrModelId, workspace.visionAnalysisModelId, workspace.ocrConsent, workspace.fontSize, workspace.readerZoom, workspace.readerTheme, workspace.readerBackgroundColor, workspace.readerTextColor, workspace.readerTranslationView]);

  useEffect(() => {
    if (!nativeRuntime || !settingsRecovered) return;
    const model = workspace.customModels.find((item) => item.id === workspace.visionAnalysisModelId);
    const provider = workspace.providers.find((item) => item.id === model?.providerId);
    if (!model || !provider) {
      void clearVisionProvider().catch(() => undefined);
      return;
    }
    void hydrateProviderCredentials([provider])
      .then(() => configureVisionProvider(provider, model))
      .catch(() => undefined);
  }, [settingsRecovered, workspace.visionAnalysisModelId, workspace.customModels, workspace.providers]);

  useEffect(() => {
    let cleanup: () => void = () => {};
    onEngineProgress(() => queryClient.invalidateQueries({ queryKey: ["papers", root] })).then((unlisten) => { cleanup = unlisten; });
    return () => cleanup();
  }, [queryClient, root]);

  useEffect(() => {
    if (!nativeRuntime || !root || !papersQuery.isSuccess) return;
    startLibraryWatcher(root).catch(() => undefined);
  }, [papersQuery.isSuccess, root]);

  useEffect(() => {
    if (!nativeRuntime || !root || !papersQuery.isSuccess) return;
    let running = false;
    const timer = window.setInterval(async () => {
      if (running) return;
      running = true;
      try {
        await scanLibrary(root, true);
        await queryClient.invalidateQueries({ queryKey: ["papers", root] });
      } finally {
        running = false;
      }
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [papersQuery.isSuccess, queryClient, root]);

  const choose = async () => {
    const selected = await chooseLibrary();
    if (!selected) return;
    await initializeLibrary(selected);
    workspace.setRoot(selected);
    await scanLibrary(selected);
    await queryClient.invalidateQueries({ queryKey: ["papers"] });
  };

  const papers = useMemo(() => {
    const all = papersQuery.data ?? [];
    const text = workspace.query.trim().toLowerCase();
    const scoped = filterPapersByCollection(all, collectionsQuery.data ?? [], workspace.selectedCollectionId);
    return scoped.filter((paper) => {
      if (text && !`${paper.title} ${paper.sourcePath}`.toLowerCase().includes(text)) return false;
      if (workspace.statusFilter === "ready") return paper.status === "READY";
      if (workspace.statusFilter === "issues") return ["FAILED", "MISSING", "CANCELLED"].includes(paper.status);
      if (workspace.statusFilter === "processing") return !["READY", "FAILED", "MISSING", "CANCELLED"].includes(paper.status);
      return true;
    });
  }, [collectionsQuery.data, papersQuery.data, workspace.query, workspace.selectedCollectionId, workspace.statusFilter]);

  const allPapers = papersQuery.data ?? [];

  useEffect(() => {
    if (allPapers[0] && !allPapers.some((paper) => paper.id === workspace.selectedPaperId)) {
      workspace.selectPaper(allPapers[0].id);
    }
  }, [allPapers, workspace]);

  useEffect(() => {
    if (workspace.view === "library" && papers[0] && !papers.some((paper) => paper.id === workspace.selectedPaperId)) {
      workspace.selectPaper(papers[0].id);
    }
  }, [papers, workspace.selectedCollectionId, workspace.view]);

  useEffect(() => {
    if (workspace.view === "reader" || !workspace.readerFocusMode) return;
    workspace.setReaderFocusMode(false);
    if (nativeRuntime) void getCurrentWindow().setFullscreen(false).catch(() => undefined);
  }, [workspace.readerFocusMode, workspace.view]);

  const selected = allPapers.find((paper) => paper.id === workspace.selectedPaperId);

  const workspaceContent = workspace.view === "settings" ? (
    <Settings />
  ) : workspace.view === "security" ? (
    <SecuritySettings />
  ) : workspace.view === "innovate" ? (
    <InnovationWorkspace papers={allPapers} />
  ) : workspace.view === "agents" ? (
    <PromptLibrary />
  ) : workspace.view === "context" ? (
    <ContextWorkspace papers={allPapers} root={root} />
  ) : workspace.view === "graph" ? (
    <CitationGraph papers={allPapers} rootPaper={selected} root={root} />
  ) : workspace.view === "import" ? (
    <ZoteroImport root={root} />
  ) : workspace.view === "jobs" ? (
    <Activity
      papers={papersQuery.data ?? []}
      jobs={jobsQuery.data ?? []}
      root={root}
      loading={jobsQuery.isLoading}
      error={jobsQuery.error instanceof Error ? jobsQuery.error : null}
      onRetry={() => void jobsQuery.refetch()}
    />
  ) : workspace.view === "reader" ? (
    <Reader paper={selected} root={root} />
  ) : papersQuery.isLoading ? (
    <LibraryStartup onRetry={() => void papersQuery.refetch()} />
  ) : papersQuery.isError ? (
    <LibraryStartup error={new Error(papersQuery.error instanceof Error ? papersQuery.error.message : String(papersQuery.error ?? "无法打开本地索引"))} onRetry={() => void papersQuery.refetch()} />
  ) : (
    <LibraryWorkspace papers={papers} allPapers={allPapers} collections={collectionsQuery.data ?? []} selected={papers.find((paper) => paper.id === workspace.selectedPaperId) ?? papers[0]} scanning={scanMutation.isPending} onScan={() => scanMutation.mutate()} onChooseLibrary={choose} />
  );

  if (!root) {
    return (
      <div className="setup-screen">
        <div className="setup-mark"><FolderOpen size={24} /></div>
        <h1>打开论文库</h1>
        <p>选择一个文件夹，Papers2Innovations 会在其中创建并管理 <code>Papers/</code> 和 <code>.p2i/</code> 目录。</p>
        <button className="primary-button" onClick={choose}><FolderOpen size={17} /> 选择文件夹</button>
      </div>
    );
  }

  return (
    <div className={`app-shell ${workspace.readerFocusMode ? "reader-focus-mode" : ""}`} data-font-size={workspace.fontSize}>
      <Topbar />
      <div className="app-main">
        <Sidebar root={root} papers={allPapers} collections={collectionsQuery.data ?? []} />
        <div className="workspace-shell">
          {workspaceContent}
        </div>
      </div>
      <AppUpdater />
    </div>
  );
}
