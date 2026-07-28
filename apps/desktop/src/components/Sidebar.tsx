import { BookOpen, Clock3, FolderInput, History, Inbox, Layers3, Network, Plus, Settings2, Star, Users } from "lucide-react";
import { useWorkspace } from "../store";

const collections = [
  ["Foundation Models", "#4f6bed"], ["Alignment & Safety", "#d64545"], ["Efficient Inference", "#28a06a"],
  ["Code Generation", "#7357d8"], ["Multimodal", "#3984d8"], ["Vision", "#d98916"],
];

export function Sidebar({ paperCount = 0 }: { paperCount?: number }) {
  const { view, setView, statusFilter, setStatusFilter } = useWorkspace();
  const goLibrary = (filter: "all" | "ready") => { setStatusFilter(filter); setView("library"); };
  return (
    <aside className="research-sidebar">
      <div className="sidebar-scroll">
        <button className={`research-nav-item ${view === "library" && statusFilter === "all" ? "active" : ""}`} onClick={() => goLibrary("all")}><BookOpen size={14} /><span>All Papers</span><b>{paperCount}</b></button>
        <button className="research-nav-item" onClick={() => goLibrary("ready")}><Star size={14} /><span>Starred</span><b>{Math.min(4, paperCount)}</b></button>
        <button className="research-nav-item" onClick={() => setView("library")}><Clock3 size={14} /><span>Recently Added</span></button>
        <button className={`research-nav-item ${view === "reader" ? "active" : ""}`} onClick={() => setView("reader")}><BookOpen size={14} /><span>Currently Reading</span><b>{paperCount ? 1 : 0}</b></button>
        <button className="research-nav-item" onClick={() => setView("library")}><Inbox size={14} /><span>Inbox / Unread</span></button>

        <div className="sidebar-divider" />
        <div className="sidebar-section-title"><span>Collections</span><button title="New collection"><Plus size={12} /></button></div>
        {collections.map(([name, color], index) => <button className="collection-row" key={name}><i style={{ background: color }} /><span>{name}</span><b>{Math.max(0, paperCount - index)}</b></button>)}

        <div className="sidebar-divider" />
        <div className="sidebar-section-title"><span>Agents</span></div>
        {[["Paper Analyst", "#4f6bed"], ["Translation", "#3984d8"], ["Figure Analyst", "#7357d8"], ["Innovation", "#28a06a"]].map(([name, color], index) => (
          <button className={`agent-row ${view === "agents" && index === 0 ? "active" : ""}`} key={name} onClick={() => setView("agents")}><i style={{ background: color }} /><span>{name}</span>{index === 0 && <em />}</button>
        ))}

        <div className="sidebar-divider" />
        <div className="sidebar-section-title"><span>Local tools</span></div>
        <button className={`research-nav-item ${view === "jobs" ? "active" : ""}`} onClick={() => setView("jobs")}><History size={14} /><span>Activity</span></button>
        <button className={`research-nav-item ${view === "import" ? "active" : ""}`} onClick={() => setView("import")}><FolderInput size={14} /><span>Zotero Import</span></button>
      </div>
      <footer className="sidebar-footer">
        <button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")} title="Settings"><Settings2 size={14} /></button>
        <button className={view === "graph" ? "active" : ""} onClick={() => setView("graph")} title="Citation graph"><Network size={14} /></button>
        <button className={view === "context" ? "active" : ""} onClick={() => setView("context")} title="Context workspace"><Layers3 size={14} /></button>
        <span><Users size={12} /> Local</span>
      </footer>
    </aside>
  );
}
