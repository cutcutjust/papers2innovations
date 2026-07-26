import { BookOpen, FolderInput, FolderOpen, History, Settings2, Sparkles } from "lucide-react";
import { useWorkspace } from "../store";

export function Sidebar() {
  const { view, setView } = useWorkspace();
  return (
    <aside className="sidebar">
      <div className="brand" aria-label="Papers2Innovations">
        <span className="brand-mark"><Sparkles size={18} /></span>
        <span>Papers<span className="brand-two">2</span>Innovations</span>
      </div>
      <nav className="primary-nav" aria-label="Primary navigation">
        <button className={view === "library" ? "active" : ""} onClick={() => setView("library")}>
          <BookOpen size={17} /> Library
        </button>
        <button className={view === "jobs" ? "active" : ""} onClick={() => setView("jobs")}>
          <History size={17} /> Activity
        </button>
        <button className={view === "import" ? "active" : ""} onClick={() => setView("import")}>
          <FolderInput size={17} /> Zotero import
        </button>
      </nav>
      <div className="sidebar-spacer" />
      <div className="sidebar-section-label">Workspace</div>
      <button className="sidebar-action" title="Change library folder">
        <FolderOpen size={16} /> Local library
      </button>
      <button className="sidebar-action" onClick={() => setView("settings")} title="OCR and component settings">
        <Settings2 size={16} /> Settings
      </button>
      <div className="alpha-label">LOCAL ALPHA · 0.1</div>
    </aside>
  );
}
