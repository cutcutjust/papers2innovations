import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen } from "lucide-react";
import { AppUpdater } from "./components/AppUpdater";
import { Activity } from "./components/Activity";
import { Settings } from "./components/Settings";
import { ZoteroImport } from "./components/ZoteroImport";
import { InnovationWorkspace } from "./components/InnovationWorkspace";
import { Reader } from "./components/Reader";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { LibraryStartup } from "./components/LibraryStartup";
import { LibraryWorkspace } from "./components/LibraryWorkspace";
import { Agents } from "./components/Agents";
import { ContextWorkspace } from "./components/ContextWorkspace";
import { CitationGraph } from "./components/CitationGraph";
import { chooseLibrary, initializeLibrary, listJobs, listPapers, nativeRuntime, onEngineProgress, scanLibrary, startLibraryWatcher } from "./lib/bridge";
import { hydrateOcrCredential } from "./lib/credentials";
import { useWorkspace } from "./store";

export function App() {
  const workspace = useWorkspace();
  const queryClient = useQueryClient();
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
    if (nativeRuntime) void hydrateOcrCredential().catch(() => undefined);
  }, []);

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
    return all.filter((paper) => {
      if (text && !`${paper.title} ${paper.sourcePath}`.toLowerCase().includes(text)) return false;
      if (workspace.statusFilter === "ready") return paper.status === "READY";
      if (workspace.statusFilter === "issues") return ["FAILED", "MISSING", "CANCELLED"].includes(paper.status);
      if (workspace.statusFilter === "processing") return !["READY", "FAILED", "MISSING", "CANCELLED"].includes(paper.status);
      return true;
    });
  }, [papersQuery.data, workspace.query, workspace.statusFilter]);

  const allPapers = papersQuery.data ?? [];

  useEffect(() => {
    if (allPapers[0] && !allPapers.some((paper) => paper.id === workspace.selectedPaperId)) {
      workspace.selectPaper(allPapers[0].id);
    }
  }, [allPapers, workspace]);

  const selected = allPapers.find((paper) => paper.id === workspace.selectedPaperId);

  const workspaceContent = workspace.view === "settings" ? (
    <Settings />
  ) : workspace.view === "innovate" ? (
    <InnovationWorkspace papers={allPapers} />
  ) : workspace.view === "agents" ? (
    <Agents />
  ) : workspace.view === "context" ? (
    <ContextWorkspace papers={allPapers} />
  ) : workspace.view === "graph" ? (
    <CitationGraph papers={allPapers} rootPaper={selected} />
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
    <LibraryStartup error={new Error(papersQuery.error instanceof Error ? papersQuery.error.message : String(papersQuery.error ?? "Unable to open the local index"))} onRetry={() => void papersQuery.refetch()} />
  ) : (
    <LibraryWorkspace papers={papers} allPapers={allPapers} selected={selected} scanning={scanMutation.isPending} onScan={() => scanMutation.mutate()} onChooseLibrary={choose} />
  );

  if (!root) {
    return (
      <div className="setup-screen">
        <div className="setup-mark"><FolderOpen size={24} /></div>
        <h1>Open your paper library</h1>
        <p>Choose a folder. Papers2Innovations will create and manage the <code>Papers/</code> and <code>.p2i/</code> structure inside it.</p>
        <button className="primary-button" onClick={choose}><FolderOpen size={17} /> Choose folder</button>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Topbar />
      <div className="app-main">
        <Sidebar paperCount={allPapers.length} />
        <div className="workspace-shell">
          {workspaceContent}
        </div>
      </div>
      <AppUpdater />
    </div>
  );
}
