import type { LibraryPaper } from "@p2i/contracts";
import { BookOpen, CheckCircle2, ChevronRight, FileText, Filter, FolderOpen, Grid2X2, Layers3, List, MoreHorizontal, RefreshCw, Search, SortAsc, Upload } from "lucide-react";
import { Status } from "./Status";
import { useWorkspace } from "../store";

interface Props {
  papers: LibraryPaper[];
  allPapers: LibraryPaper[];
  selected?: LibraryPaper;
  scanning: boolean;
  onScan: () => void;
  onChooseLibrary: () => void;
}

export function LibraryWorkspace({ papers, allPapers, selected, scanning, onScan, onChooseLibrary }: Props) {
  const { selectedPaperId, selectPaper, openReader, query, setQuery } = useWorkspace();
  return (
    <div className="library-workspace">
      <header className="page-header figma-page-header">
        <div><h1>论文库</h1><p>{allPapers.length} 篇论文 · 本地研究资料库</p></div>
        <div className="page-actions">
          <button className="secondary-button"><Upload size={14} /> 添加 PDF</button>
          <button className="primary-button compact" onClick={onChooseLibrary}><FolderOpen size={14} /> 打开论文文件夹</button>
        </div>
      </header>
      <div className="library-toolbar">
        <label className="figma-input library-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="在论文库中搜索" /></label>
        <button><Filter size={13} /> 筛选</button><button><SortAsc size={13} /> 排序</button><button><Layers3 size={13} /> 分组</button>
        <button onClick={onScan} disabled={scanning}><RefreshCw size={13} className={scanning ? "spin" : ""} /> 扫描</button>
        <div className="view-switch"><button className="active" title="表格视图"><List size={13} /></button><button title="网格视图"><Grid2X2 size={13} /></button></div>
      </div>
      <div className="library-surface">
        <section className="paper-table-wrap">
          <div className="paper-table-head"><span>标题</span><span>状态</span><span>页数</span><span>更新时间</span><span /></div>
          <div className="figma-paper-table">
            {papers.map((paper, index) => (
              <button key={paper.id} className={`figma-paper-row ${selectedPaperId === paper.id ? "selected" : ""}`} onClick={() => selectPaper(paper.id)} onDoubleClick={() => openReader(paper.id)}>
                <span className="paper-title-cell"><span className="paper-doc-icon"><FileText size={15} /></span><span><strong>{paper.title}</strong><small>{paper.sourcePath}</small><em>{index % 3 === 0 ? "基础模型" : index % 3 === 1 ? "多模态" : "本地论文库"}</em></span></span>
                <span><Status status={paper.status} /></span>
                <span className="mono-cell">{paper.pageCount || "—"}</span>
                <span>{new Date(paper.updatedAt).toLocaleDateString()}</span>
                <span><MoreHorizontal size={15} /></span>
              </button>
            ))}
            {!papers.length && <div className="empty-table"><FileText size={28} /><strong>没有符合条件的论文</strong><span>请尝试更改搜索内容或筛选条件。</span></div>}
          </div>
        </section>
        <aside className="library-inspector">
          {!selected ? <div className="empty-inspector"><BookOpen size={30} /><span>选择一篇论文查看详情</span></div> : <>
            <div className="paper-preview"><div><i /><i /><i /><b /></div></div>
            <div className="inspector-content">
              <div className="inspector-tags"><span className="tag tag-primary">本地论文</span><Status status={selected.status} /></div>
              <h2>{selected.title}</h2><p className="inspector-source">{selected.sourcePath}</p>
              {selected.progress > 0 && selected.progress < 1 && <div className="figma-progress"><i style={{ width: `${selected.progress * 100}%` }} /></div>}
              <dl className="paper-facts"><div><dt>Markdown</dt><dd>{selected.markdownPath ? "可用" : "处理中"}</dd></div><div><dt>插图</dt><dd>{selected.figures.length}</dd></div><div><dt>页数</dt><dd>{selected.pageCount || "—"}</dd></div><div><dt>更新时间</dt><dd>{new Date(selected.updatedAt).toLocaleDateString("zh-CN")}</dd></div></dl>
              <div className="inspector-actions"><button className="primary-button compact" onClick={() => openReader(selected.id)}><BookOpen size={13} /> 在阅读器中打开</button><button className="secondary-button" onClick={() => useWorkspace.getState().setView("context")}><Layers3 size={13} /> 添加到上下文</button><button className="secondary-button"><CheckCircle2 size={13} /> 导出引用 <ChevronRight size={12} /></button></div>
            </div>
          </>}
        </aside>
      </div>
    </div>
  );
}
