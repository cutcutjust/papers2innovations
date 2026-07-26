import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, LoaderCircle } from "lucide-react";
import { Activity } from "./components/Activity";
import { Settings } from "./components/Settings";
import { ZoteroImport } from "./components/ZoteroImport";
import { Inspector } from "./components/Inspector";
import { PaperList } from "./components/PaperList";
import { Reader } from "./components/Reader";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
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
    queryFn: () => listPapers(root),
    enabled: Boolean(root),
    refetchInterval: nativeRuntime ? 4_000 : false,
  });
  const scanMutation = useMutation({
    mutationFn: () => scanLibrary(root),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["papers", root] }),
  });
  const jobsQuery = useQuery({
    queryKey: ["jobs", root],
    queryFn: () => listJobs(root),
    enabled: Boolean(root && workspace.view === "jobs"),
    refetchInterval: 2_000,
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
    if (!nativeRuntime || !root) return;
    startLibraryWatcher(root).catch(() => undefined);
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
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [queryClient, root]);

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

  useEffect(() => {
    if (papers[0] && !papers.some((paper) => paper.id === workspace.selectedPaperId)) {
      workspace.selectPaper(papers[0].id);
    }
  }, [papers, workspace]);

  const selected = papers.find((paper) => paper.id === workspace.selectedPaperId);

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
      <Sidebar />
      <div className="workspace-shell">
        <Topbar scanning={scanMutation.isPending} onScan={() => scanMutation.mutate()} onChooseLibrary={choose} />
        {papersQuery.isLoading ? <div className="app-loading"><LoaderCircle className="spin" /><span>Opening local index…</span></div> : workspace.view === "jobs" ? (
          <Activity papers={papersQuery.data ?? []} jobs={jobsQuery.data ?? []} root={root} />
        ) : workspace.view === "import" ? (
          <ZoteroImport root={root} />
        ) : workspace.view === "settings" ? (
          <Settings />
        ) : (
          <div className="content-grid">
            <PaperList papers={papers} />
            <Reader paper={selected} root={root} />
            <Inspector paper={selected} />
          </div>
        )}
      </div>
    </div>
  );
}
