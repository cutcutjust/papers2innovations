import { useEffect, useMemo, useRef, useState } from "react";
import type { LibraryPaper } from "@p2i/contracts";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { documentDir, join } from "@tauri-apps/api/path";
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
import { ModelActivityCenter } from "./components/ModelActivityCenter";
import { PaperImportDialog } from "./components/PaperImportDialog";
import { FirstRunOnboarding } from "./components/FirstRunOnboarding";
import { chooseLibrary, initializeLibrary, listCollections, listJobs, listPapers, nativeRuntime, onEngineProgress, scanLibrary, setPaperFavorite, startLibraryWatcher } from "./lib/bridge";
import { clearVisionProvider, configureVisionProvider, hydrateOcrCredential, hydrateProviderCredentials, loadWorkspaceSettingsSnapshot, saveWorkspaceSettingsSnapshot } from "./lib/credentials";
import { filterPapersByCollection } from "./lib/collectionTree";
import { papersForLibraryScope } from "./lib/libraryScope";
import { isPlaceholderProvider } from "./lib/providerConfig";
import { CURRENT_ONBOARDING_VERSION, hasPersistedWorkspaceSettings, useWorkspace } from "./store";

export function App() {
  const workspace = useWorkspace();
  const queryClient = useQueryClient();
  const settingsRecoveryStarted = useRef(false);
  const [settingsRecovered, setSettingsRecovered] = useState(!nativeRuntime);
  const [suggestedRoot, setSuggestedRoot] = useState("");
  const [librarySetupBusy, setLibrarySetupBusy] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [dropNotice, setDropNotice] = useState("");
  const root = workspace.root || (!nativeRuntime ? "D:/Research/Papers2Innovations-Library" : "");
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
  const favoriteMutation = useMutation({
    mutationFn: ({ paperId, favorite }: { paperId: string; favorite: boolean }) => setPaperFavorite(root, paperId, favorite),
    onMutate: async ({ paperId, favorite }) => {
      await queryClient.cancelQueries({ queryKey: ["papers", root] });
      const previous = queryClient.getQueryData<LibraryPaper[]>(["papers", root]);
      queryClient.setQueryData<LibraryPaper[]>(["papers", root], (current = []) => current.map((paper) => paper.id === paperId ? {
        ...paper,
        isFavorite: favorite,
        favoritedAt: favorite ? new Date().toISOString() : undefined,
      } : paper));
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(["papers", root], context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["papers", root] }),
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
    if (root || !nativeRuntime) return;
    void documentDir()
      .then((directory) => join(directory, "Papers2Innovations-Library"))
      .then(setSuggestedRoot)
      .catch(() => setSuggestedRoot(""));
  }, [root]);

  useEffect(() => {
    if (!nativeRuntime || settingsRecoveryStarted.current) return;
    settingsRecoveryStarted.current = true;
    void loadWorkspaceSettingsSnapshot()
      .then((snapshot) => {
        if (snapshot && !hasPersistedWorkspaceSettings) workspace.restoreWorkspaceSettings(snapshot);
      })
      .then(async () => {
        const state = useWorkspace.getState();
        const providers = state.providers;
        await hydrateOcrCredential().catch(() => undefined);
        const summaries = await hydrateProviderCredentials(providers).catch(() => []);
        const configured = new Set(summaries.filter((item) => item.configured).map((item) => item.credentialId));
        for (const model of state.customModels) {
          const provider = state.providers.find((item) => item.id === model.providerId);
          if (provider && isPlaceholderProvider(provider) && !configured.has(provider.credentialId)) {
            useWorkspace.getState().removeCustomModel(model.id);
          }
        }
      })
      .finally(() => setSettingsRecovered(true));
  }, []);

  useEffect(() => {
    if (!nativeRuntime || !settingsRecovered) return;
    void saveWorkspaceSettingsSnapshot({
      version: 4,
      root: workspace.root,
      providers: workspace.providers,
      customModels: workspace.customModels,
      defaultTextModelId: workspace.defaultTextModelId,
      translationModelId: workspace.translationModelId,
      onboardingVersion: workspace.onboardingVersion,
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
      readerAnnotationsVisible: workspace.readerAnnotationsVisible,
    }).catch(() => undefined);
  }, [settingsRecovered, workspace.root, workspace.providers, workspace.customModels, workspace.defaultTextModelId, workspace.translationModelId, workspace.onboardingVersion, workspace.contextCompressionModelId, workspace.markdownFormattingModelId, workspace.autoFormatMarkdown, workspace.fullPageOcrModelId, workspace.visionAnalysisModelId, workspace.ocrConsent, workspace.fontSize, workspace.readerZoom, workspace.readerTheme, workspace.readerBackgroundColor, workspace.readerTextColor, workspace.readerTranslationView, workspace.readerAnnotationsVisible]);

  useEffect(() => {
    if (!nativeRuntime) return;
    let cleanup: () => void = () => {};
    void getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type === "over") {
        setDropActive(true);
        return;
      }
      setDropActive(false);
      if (event.payload.type !== "drop") return;
      if (!root) {
        setDropNotice("请先创建或选择本地论文库，再拖入 PDF。");
        return;
      }
      const paths = event.payload.paths;
      if (!paths.length || paths.some((path) => !path.toLowerCase().endsWith(".pdf"))) {
        setDropNotice("只能导入 PDF 文件；文件夹和其他格式不会进入论文库。");
        return;
      }
      setDropNotice("");
      workspace.openPaperImport(paths);
    }).then((unlisten) => { cleanup = unlisten; });
    return () => cleanup();
  }, [root]);

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

  const createSuggestedLibrary = async () => {
    const target = suggestedRoot || (!nativeRuntime ? "D:/Research/Papers2Innovations-Library" : "");
    if (!target || librarySetupBusy) return;
    setLibrarySetupBusy(true);
    try {
      await initializeLibrary(target);
      workspace.setRoot(target);
      await scanLibrary(target);
      await queryClient.invalidateQueries({ queryKey: ["papers"] });
    } finally {
      setLibrarySetupBusy(false);
    }
  };

  const papers = useMemo(() => {
    const all = papersQuery.data ?? [];
    const text = workspace.query.trim().toLowerCase();
    const scoped = filterPapersByCollection(all, collectionsQuery.data ?? [], workspace.selectedCollectionId);
    return papersForLibraryScope(scoped, workspace.libraryScope).filter((paper) => {
      if (text && !`${paper.title} ${paper.sourcePath}`.toLowerCase().includes(text)) return false;
      if (workspace.statusFilter === "ready") return paper.status === "READY";
      if (workspace.statusFilter === "issues") return ["FAILED", "MISSING", "CANCELLED"].includes(paper.status);
      if (workspace.statusFilter === "processing") return !["READY", "FAILED", "MISSING", "CANCELLED"].includes(paper.status);
      return true;
    });
  }, [collectionsQuery.data, papersQuery.data, workspace.libraryScope, workspace.query, workspace.selectedCollectionId, workspace.statusFilter]);

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
    <ZoteroImport root={root} onChooseLibrary={choose} />
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
    <LibraryWorkspace papers={papers} allPapers={allPapers} collections={collectionsQuery.data ?? []} selected={papers.find((paper) => paper.id === workspace.selectedPaperId) ?? papers[0]} scope={workspace.libraryScope} favoriteBusyId={favoriteMutation.isPending ? favoriteMutation.variables?.paperId : undefined} scanning={scanMutation.isPending} onScan={() => scanMutation.mutate()} onChooseLibrary={choose} onToggleFavorite={(paper) => favoriteMutation.mutate({ paperId: paper.id, favorite: !paper.isFavorite })} onShowAll={() => { workspace.setLibraryScope("all"); workspace.setSelectedCollectionId(undefined); }} />
  );

  const forceOnboardingPreview = !nativeRuntime && new URLSearchParams(window.location.search).has("onboarding");
  if (!settingsRecovered) return <LibraryStartup onRetry={() => window.location.reload()} />;
  if (!root || workspace.onboardingVersion < CURRENT_ONBOARDING_VERSION || forceOnboardingPreview) {
    return <FirstRunOnboarding root={forceOnboardingPreview ? workspace.root : root} suggestedRoot={suggestedRoot || (!nativeRuntime ? "D:/Research/Papers2Innovations-Library" : "")} libraryBusy={librarySetupBusy} onCreateLibrary={createSuggestedLibrary} onChooseLibrary={choose} />;
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
      <ModelActivityCenter />
      <PaperImportDialog
        root={root}
        open={workspace.importDialogOpen}
        pendingPaths={workspace.pendingImportPaths}
        onClose={workspace.closePaperImport}
        onImported={() => {
          scanMutation.mutate();
          window.setTimeout(() => void queryClient.invalidateQueries({ queryKey: ["papers", root] }), 1_000);
        }}
        onOpenZotero={() => workspace.setView("import")}
        onOpenActivity={() => workspace.setView("jobs")}
        onOpenSettings={() => { workspace.closePaperImport(); workspace.setView("settings"); }}
      />
      {dropActive && <div className="native-drop-overlay"><FolderOpen size={30} /><strong>松开即可导入 PDF</strong><span>文件会复制到本地论文库</span></div>}
      {dropNotice && <div className="native-drop-notice" role="alert"><span>{dropNotice}</span><button onClick={() => setDropNotice("")}>知道了</button></div>}
    </div>
  );
}
