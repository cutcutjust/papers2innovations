import { BookOpen, Clock3, FolderInput, History, Inbox, Layers3, Network, Plus, Settings2, Star, Users } from "lucide-react";
import { useWorkspace } from "../store";

const collections = [
  ["基础模型", "#4f6bed"], ["对齐与安全", "#d64545"], ["高效推理", "#28a06a"],
  ["代码生成", "#7357d8"], ["多模态", "#3984d8"], ["计算机视觉", "#d98916"],
];

export function Sidebar({ paperCount = 0 }: { paperCount?: number }) {
  const { view, setView, statusFilter, setStatusFilter } = useWorkspace();
  const goLibrary = (filter: "all" | "ready") => { setStatusFilter(filter); setView("library"); };
  return (
    <aside className="research-sidebar">
      <div className="sidebar-scroll">
        <button className={`research-nav-item ${view === "library" && statusFilter === "all" ? "active" : ""}`} onClick={() => goLibrary("all")}><BookOpen size={14} /><span>全部论文</span><b>{paperCount}</b></button>
        <button className="research-nav-item" onClick={() => goLibrary("ready")}><Star size={14} /><span>已收藏</span><b>{Math.min(4, paperCount)}</b></button>
        <button className="research-nav-item" onClick={() => setView("library")}><Clock3 size={14} /><span>最近添加</span></button>
        <button className={`research-nav-item ${view === "reader" ? "active" : ""}`} onClick={() => setView("reader")}><BookOpen size={14} /><span>正在阅读</span><b>{paperCount ? 1 : 0}</b></button>
        <button className="research-nav-item" onClick={() => setView("library")}><Inbox size={14} /><span>收件箱 / 未读</span></button>

        <div className="sidebar-divider" />
        <div className="sidebar-section-title"><span>分类</span><button title="新建分类"><Plus size={12} /></button></div>
        {collections.map(([name, color], index) => <button className="collection-row" key={name}><i style={{ background: color }} /><span>{name}</span><b>{Math.max(0, paperCount - index)}</b></button>)}

        <div className="sidebar-divider" />
        <div className="sidebar-section-title"><span>智能体</span></div>
        {[["论文分析", "#4f6bed"], ["翻译", "#3984d8"], ["图表分析", "#7357d8"], ["创新分析", "#28a06a"]].map(([name, color], index) => (
          <button className={`agent-row ${view === "agents" && index === 0 ? "active" : ""}`} key={name} onClick={() => setView("agents")}><i style={{ background: color }} /><span>{name}</span>{index === 0 && <em />}</button>
        ))}

        <div className="sidebar-divider" />
        <div className="sidebar-section-title"><span>本地工具</span></div>
        <button className={`research-nav-item ${view === "jobs" ? "active" : ""}`} onClick={() => setView("jobs")}><History size={14} /><span>任务活动</span></button>
        <button className={`research-nav-item ${view === "import" ? "active" : ""}`} onClick={() => setView("import")}><FolderInput size={14} /><span>导入 Zotero</span></button>
      </div>
      <footer className="sidebar-footer">
        <button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")} title="设置"><Settings2 size={14} /></button>
        <button className={view === "graph" ? "active" : ""} onClick={() => setView("graph")} title="引用图谱"><Network size={14} /></button>
        <button className={view === "context" ? "active" : ""} onClick={() => setView("context")} title="上下文工作区"><Layers3 size={14} /></button>
        <span><Users size={12} /> 本地</span>
      </footer>
    </aside>
  );
}
