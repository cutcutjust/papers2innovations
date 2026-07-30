import type { LibraryCollection, LibraryPaper } from "@p2i/contracts";
import { BookOpen, CheckCircle2, ChevronRight, FileText, Filter, FolderOpen, Grid2X2, GripVertical, Layers3, List, RefreshCw, Search, SortAsc, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Status } from "./Status";
import { useWorkspace } from "../store";
import { startPointerCollectionDrag, subscribeCollectionDrag } from "../lib/collectionDrag";
import { ModelReadinessBanner } from "./ModelReadinessBanner";

interface Props {
  papers: LibraryPaper[];
  allPapers: LibraryPaper[];
  collections: LibraryCollection[];
  selected?: LibraryPaper;
  scanning: boolean;
  onScan: () => void;
  onChooseLibrary: () => void;
}

export function LibraryWorkspace({ papers, allPapers, collections, selected, scanning, onScan, onChooseLibrary }: Props) {
  const { selectedPaperId, selectPaper, openReader, query, setQuery, openPaperImport } = useWorkspace();
  const [draggingPaperId, setDraggingPaperId] = useState("");
  const collectionNames = useMemo(() => new Map(collections.map((item) => [item.id, item.name])), [collections]);
  useEffect(() => subscribeCollectionDrag((payload) => setDraggingPaperId(payload?.kind === "paper" ? payload.id : "")), []);
  return (
    <div className="library-workspace">
      <header className="page-header figma-page-header">
        <div><h1>论文库</h1><p>{allPapers.length} 篇论文 · 本地研究资料库</p></div>
        <div className="page-actions">
          <button className="primary-button compact" onClick={() => openPaperImport()}><Upload size={14} /> 添加论文</button>
          <button className="secondary-button" onClick={onChooseLibrary}><FolderOpen size={14} /> 更换资料库</button>
        </div>
      </header>
      <ModelReadinessBanner />
      <div className="library-toolbar">
        <label className="figma-input library-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="在论文库中搜索" /></label>
        <button><Filter size={13} /> 筛选</button><button><SortAsc size={13} /> 排序</button><button><Layers3 size={13} /> 分组</button>
        <button onClick={onScan} disabled={scanning}><RefreshCw size={13} className={scanning ? "spin" : ""} /> 扫描</button>
        <div className="view-switch"><button className="active" title="表格视图"><List size={13} /></button><button title="网格视图"><Grid2X2 size={13} /></button></div>
      </div>
      {!allPapers.length ? <section className="empty-library-welcome">
        <div className="empty-library-copy"><span className="empty-library-mark"><Upload size={24} /></span><p>本地论文库已准备好</p><h2>添加第一批论文开始阅读</h2><span>选择或拖入一篇或多篇 PDF。Papers2Innovations 会复制、去重并在本地建立结构化文档。</span><button className="primary-button" onClick={() => openPaperImport()}><Upload size={16} /> 添加本地 PDF</button><small>原文件不会被移动或修改</small></div>
        <div className="empty-library-details"><article><FileText size={18} /><div><strong>自动结构化</strong><span>提取章节、公式、插图和表格</span></div></article><article><Layers3 size={18} /><div><strong>自动进入任务队列</strong><span>关闭应用后仍可恢复解析进度</span></div></article><button onClick={() => useWorkspace.getState().setView("import")}><FolderOpen size={17} /><span><strong>从 Zotero 导入</strong><small>可选，按 collection 预览并选择</small></span><ChevronRight size={14} /></button></div>
      </section> : <div className="library-surface">
        <section className="paper-table-wrap">
          <div className="paper-table-head"><span>标题</span><span>状态</span><span>页数</span><span>更新时间</span><span /></div>
          <div className="figma-paper-table">
            {papers.map((paper) => (
              <button key={paper.id} className={`figma-paper-row ${selectedPaperId === paper.id ? "selected" : ""} ${draggingPaperId === paper.id ? "dragging" : ""}`} onClick={() => selectPaper(paper.id)} onDoubleClick={() => openReader(paper.id)} onPointerDown={(event) => startPointerCollectionDrag({ kind: "paper", id: paper.id }, event)} title="拖动到左侧分类完成归组">
                <span className="paper-title-cell"><span className="paper-doc-icon"><FileText size={15} /></span><span><strong>{paper.title}</strong><small>{paper.sourcePath}</small><em>{paper.collectionIds[0] ? collectionNames.get(paper.collectionIds[0]) ?? "已分类" : "未分类"}</em></span></span>
                <span><Status status={paper.status} /></span>
                <span className="mono-cell">{paper.pageCount || "—"}</span>
                <span>{new Date(paper.updatedAt).toLocaleDateString()}</span>
                <span className="paper-drag-handle" title="拖动归组"><GripVertical size={15} /></span>
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
      </div>}
    </div>
  );
}
