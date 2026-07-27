import { Atom, Search, Sparkles } from "lucide-react";
import { useWorkspace, type View } from "../store";

const primaryViews: Array<{ view: View; label: string }> = [
  { view: "library", label: "Library" },
  { view: "reader", label: "Reader" },
  { view: "agents", label: "Agents" },
  { view: "graph", label: "Graph" },
  { view: "innovate", label: "Innovate" },
];

export function Topbar() {
  const { view, setView, query, setQuery } = useWorkspace();
  return (
    <header className="figma-topbar">
      <div className="window-controls" aria-hidden="true"><i /><i /><i /></div>
      <button className="figma-brand" onClick={() => setView("library")}>
        <span><Atom size={15} /></span><strong>Papers2Innovations</strong>
      </button>
      <nav className="top-navigation" aria-label="Product navigation">
        {primaryViews.map((item) => (
          <button key={item.view} className={view === item.view ? "active" : ""} onClick={() => setView(item.view)}>{item.label}</button>
        ))}
      </nav>
      <label className="top-command-search">
        <Search size={14} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search papers" aria-label="Search papers" />
      </label>
      <button className="top-ai-button" title="AI actions"><Sparkles size={14} /></button>
      <span className="user-avatar">RW</span>
    </header>
  );
}
