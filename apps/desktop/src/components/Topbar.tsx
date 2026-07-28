import { Search } from "lucide-react";
import appIcon from "../assets/p2i-app-icon.svg";
import { useWorkspace, type View } from "../store";

const primaryViews: Array<{ view: View; label: string }> = [
  { view: "library", label: "论文库" },
  { view: "reader", label: "阅读器" },
  { view: "agents", label: "智能体" },
  { view: "graph", label: "引用图谱" },
  { view: "innovate", label: "创新工作台" },
];

export function Topbar() {
  const { view, setView, query, setQuery } = useWorkspace();
  return (
    <header className="figma-topbar">
      <div className="window-controls" aria-hidden="true"><i /><i /><i /></div>
      <button className="figma-brand" onClick={() => setView("library")}>
        <span><img src={appIcon} alt="" /></span><strong>Papers2Innovations</strong>
      </button>
      <nav className="top-navigation" aria-label="主导航">
        {primaryViews.map((item) => (
          <button key={item.view} className={view === item.view ? "active" : ""} onClick={() => setView(item.view)}>{item.label}</button>
        ))}
      </nav>
      <label className="top-command-search">
        <Search size={14} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索论文" aria-label="搜索论文" />
      </label>
    </header>
  );
}
