import type { LibraryCollection, LibraryPaper } from "@p2i/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { BookOpen, BookOpenText, CalendarClock, CheckCircle2, ChevronRight, Clock3, FilePenLine, FileText, Filter, FolderOpen, Grid2X2, GripVertical, Layers3, List, RefreshCw, Search, SortAsc, Star, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Status } from "./Status";
import { useWorkspace, type LibraryScope } from "../store";
import { startPointerCollectionDrag, subscribeCollectionDrag } from "../lib/collectionDrag";
import { ModelReadinessBanner } from "./ModelReadinessBanner";
import { PaperLibraryDialog } from "./PaperLibraryDialog";

interface Props {
  root: string;
  papers: LibraryPaper[];
  allPapers: LibraryPaper[];
  collections: LibraryCollection[];
  selected?: LibraryPaper;
  scope: LibraryScope;
  favoriteBusyId?: string;
  scanning: boolean;
  onScan: () => void;
  onChooseLibrary: () => void;
  onToggleFavorite: (paper: LibraryPaper) => void;
  onShowAll: () => void;
}

const scopeCopy: Record<LibraryScope, { title: string; description: (count: number) => string; emptyTitle: string; emptyText: string }> = {
  all: { title: "论文库", description: (count) => `${count} 篇论文 · 本地研究资料库`, emptyTitle: "没有符合条件的论文", emptyText: "请尝试更改搜索内容或筛选条件。" },
  favorites: { title: "已收藏", description: (count) => `${count} 篇重点论文 · 收藏状态保存在本地论文库`, emptyTitle: "还没有收藏论文", emptyText: "在论文列表或详情栏点击星标，即可把重要论文集中到这里。" },
  recent: { title: "最近添加", description: (count) => `${count} 篇论文 · 按加入资料库的时间排序`, emptyTitle: "暂无最近添加的论文", emptyText: "添加本地 PDF 后会自动出现在这里。" },
  reading: { title: "正在阅读", description: (count) => `${count} 篇有阅读记录的论文 · 自动保存章节与页码`, emptyTitle: "还没有阅读记录", emptyText: "打开任意论文开始阅读，系统会自动保存章节、页码和阅读进度。" },
};

const displayDate = (value?: string) => value ? new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

export function LibraryWorkspace({ root, papers, allPapers, collections, selected, scope, favoriteBusyId, scanning, onScan, onChooseLibrary, onToggleFavorite, onShowAll }: Props) {
  const queryClient = useQueryClient();
  const { selectedPaperId, selectPaper, openReader, query, setQuery, openPaperImport } = useWorkspace();
  const [draggingPaperId, setDraggingPaperId] = useState("");
  const [managePaper, setManagePaper] = useState<{ paper: LibraryPaper; mode: "edit" | "delete" } | null>(null);
  const [notice, setNotice] = useState("");
  const collectionNames = useMemo(() => new Map(collections.map((item) => [item.id, item.name])), [collections]);
  const copy = scopeCopy[scope];
  const emptyIcon = scope === "favorites" ? <Star size={30} /> : scope === "reading" ? <BookOpenText size={30} /> : scope === "recent" ? <CalendarClock size={30} /> : <FileText size={28} />;
  useEffect(() => subscribeCollectionDrag((payload) => setDraggingPaperId(payload?.kind === "paper" ? payload.id : "")), []);
  return (
    <div className="library-workspace">
      <header className="page-header figma-page-header">
        <div><h1>{copy.title}</h1><p>{copy.description(papers.length)}</p></div>
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
          <div className="paper-table-head"><span>标题</span><span>{scope === "reading" ? "阅读进度" : "状态"}</span><span>页数</span><span>{scope === "reading" ? "最近阅读" : scope === "favorites" ? "收藏时间" : scope === "recent" ? "添加时间" : "更新时间"}</span><span /></div>
          <div className="figma-paper-table">
            {papers.map((paper) => (
              <div key={paper.id} role="button" tabIndex={0} className={`figma-paper-row ${selectedPaperId === paper.id ? "selected" : ""} ${draggingPaperId === paper.id ? "dragging" : ""}`} onClick={() => selectPaper(paper.id)} onDoubleClick={() => openReader(paper.id)} onKeyDown={(event) => { if (event.key === "Enter") openReader(paper.id); else if (event.key === " ") { event.preventDefault(); selectPaper(paper.id); } }} onPointerDown={(event) => startPointerCollectionDrag({ kind: "paper", id: paper.id }, event)} title="双击打开；拖动到左侧分类完成归组">
                <span className="paper-title-cell"><span className="paper-doc-icon"><FileText size={15} /></span><span><strong>{paper.title}</strong><small>{paper.sourcePath}</small><em>{paper.collectionIds[0] ? collectionNames.get(paper.collectionIds[0]) ?? "已分类" : "未分类"}</em></span></span>
                {scope === "reading" ? <span className="reading-progress-cell"><span><i style={{ width: `${Math.round(paper.readingProgress * 100)}%` }} /></span><b>{Math.round(paper.readingProgress * 100)}%</b></span> : <span><Status status={paper.status} /></span>}
                <span className="mono-cell">{paper.pageCount || "—"}</span>
                <span>{scope === "reading" ? displayDate(paper.lastReadAt) : scope === "favorites" ? displayDate(paper.favoritedAt) : new Date(scope === "recent" ? paper.createdAt : paper.updatedAt).toLocaleDateString("zh-CN")}</span>
                <span className="paper-row-actions"><button className={paper.isFavorite ? "active" : ""} disabled={favoriteBusyId === paper.id} title={paper.isFavorite ? "取消收藏" : "收藏论文"} aria-label={paper.isFavorite ? "取消收藏" : "收藏论文"} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onToggleFavorite(paper); }}><Star size={14} fill={paper.isFavorite ? "currentColor" : "none"} /></button><i className="paper-drag-handle" title="拖动归组"><GripVertical size={15} /></i></span>
              </div>
            ))}
            {!papers.length && <div className="empty-table library-scope-empty">{emptyIcon}<strong>{copy.emptyTitle}</strong><span>{copy.emptyText}</span>{scope !== "all" && <button className="secondary-button" onClick={onShowAll}>浏览全部论文</button>}</div>}
          </div>
        </section>
        <aside className="library-inspector">
          {!selected ? <div className="empty-inspector"><BookOpen size={30} /><span>选择一篇论文查看详情</span></div> : <>
            <div className="paper-preview"><div><i /><i /><i /><b /></div></div>
            <div className="inspector-content">
              <div className="inspector-tags"><span className="tag tag-primary">本地论文</span><Status status={selected.status} /><button className={`inspector-favorite ${selected.isFavorite ? "active" : ""}`} disabled={favoriteBusyId === selected.id} title={selected.isFavorite ? "取消收藏" : "收藏论文"} onClick={() => onToggleFavorite(selected)}><Star size={14} fill={selected.isFavorite ? "currentColor" : "none"} /></button></div>
              <h2>{selected.title}</h2>{selected.authors.length > 0 && <p className="inspector-authors">{selected.authors.join(" · ")}{selected.year ? ` · ${selected.year}` : ""}</p>}<p className="inspector-source">{selected.sourcePath}</p>
              {selected.lastReadAt ? <div className="inspector-reading-progress"><div><span>阅读进度</span><b>{Math.round(selected.readingProgress * 100)}%</b></div><i><em style={{ width: `${Math.round(selected.readingProgress * 100)}%` }} /></i><small><Clock3 size={11} /> 最近阅读 {displayDate(selected.lastReadAt)}{selected.lastPage ? ` · 第 ${selected.lastPage} 页` : ""}</small></div> : selected.progress > 0 && selected.progress < 1 ? <div className="figma-progress"><i style={{ width: `${selected.progress * 100}%` }} /></div> : null}
              <dl className="paper-facts"><div><dt>Markdown</dt><dd>{selected.markdownPath ? "可用" : "处理中"}</dd></div><div><dt>插图</dt><dd>{selected.figures.length}</dd></div><div><dt>页数</dt><dd>{selected.pageCount || "—"}</dd></div><div><dt>{selected.lastReadAt ? "上次位置" : "更新时间"}</dt><dd>{selected.lastPage ? `第 ${selected.lastPage} 页` : new Date(selected.updatedAt).toLocaleDateString("zh-CN")}</dd></div></dl>
              <div className="inspector-actions"><button className="primary-button compact" onClick={() => openReader(selected.id)}><BookOpen size={13} /> {selected.lastReadAt ? "继续阅读" : "开始阅读"}</button><button className="secondary-button" onClick={() => useWorkspace.getState().setView("context")}><Layers3 size={13} /> 添加到上下文</button><button className="secondary-button" onClick={() => setManagePaper({ paper: selected, mode: "edit" })}><FilePenLine size={13} /> 编辑论文信息</button><button className="secondary-button inspector-delete-paper" onClick={() => setManagePaper({ paper: selected, mode: "delete" })}><Trash2 size={13} /> 从论文库删除</button><button className="secondary-button"><CheckCircle2 size={13} /> 导出引用 <ChevronRight size={12} /></button></div>
            </div>
          </>}
        </aside>
      </div>}
      {notice && <div className="library-action-notice" role="status">{notice}<button onClick={() => setNotice("")}>知道了</button></div>}
      {managePaper && <PaperLibraryDialog key={`${managePaper.paper.id}:${managePaper.mode}`} root={root} paper={managePaper.paper} initialMode={managePaper.mode} onClose={() => setManagePaper(null)} onSaved={(updated) => {
        queryClient.setQueryData<LibraryPaper[]>(["papers", root], (current = []) => current.map((paper) => paper.id === updated.id ? updated : paper));
        setNotice("论文信息已保存，后续重新解析会保留人工修订。");
      }} onDeleted={(result) => {
        queryClient.setQueryData<LibraryPaper[]>(["papers", root], (current = []) => current.filter((paper) => paper.id !== result.paperId));
        const next = allPapers.find((paper) => paper.id !== result.paperId);
        if (next) selectPaper(next.id);
        void queryClient.invalidateQueries({ queryKey: ["collections", root] });
        void queryClient.invalidateQueries({ queryKey: ["jobs", root] });
        setNotice(result.warning ? `论文已删除；${result.warning}` : "论文及其受管副本已从本地论文库删除。");
      }} />}
    </div>
  );
}
