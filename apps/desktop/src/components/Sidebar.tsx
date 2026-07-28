import type { LibraryCollection, LibraryPaper } from "@p2i/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { BookOpen, Bot, Check, ChevronRight, Clock3, FileText, Folder, FolderInput, FolderOpen, FolderPlus, GripVertical, History, Inbox, Layers3, Network, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Settings2, Star, Trash2, TriangleAlert, Users, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createCollection, deleteCollection, movePaperToCollection, updateCollection } from "../lib/bridge";
import { buildCollectionTree, collectionScopeIds, type CollectionTreeNode } from "../lib/collectionTree";
import { useWorkspace } from "../store";

const colors = ["#4f6bed", "#3984d8", "#28a06a", "#7357d8", "#d64545", "#d98916"];
type EditorState = { mode: "create" | "rename"; parentId?: string; collection?: LibraryCollection; name: string; color: string };
const SIDEBAR_WIDTH_KEY = "p2i.sidebar-width";
const SIDEBAR_COLLAPSED_KEY = "p2i.sidebar-collapsed";
const DEFAULT_SIDEBAR_WIDTH = 232;
const MIN_SIDEBAR_WIDTH = 190;
const MAX_SIDEBAR_WIDTH = 360;
const COLLAPSED_SIDEBAR_WIDTH = 52;
const clampSidebarWidth = (width: number) => Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));

export function Sidebar({ root, papers, collections }: { root: string; papers: LibraryPaper[]; collections: LibraryCollection[] }) {
  const queryClient = useQueryClient();
  const { view, setView, statusFilter, setStatusFilter, selectedCollectionId, setSelectedCollectionId, selectedPaperId, selectPaper, openReader } = useWorkspace();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const initialExpansionApplied = useRef(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [dropTarget, setDropTarget] = useState("");
  const [draggingCollectionId, setDraggingCollectionId] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [collapsed, setCollapsed] = useState(() => window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true");
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? clampSidebarWidth(saved) : DEFAULT_SIDEBAR_WIDTH;
  });
  const sidebarDrag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const tree = useMemo(() => buildCollectionTree(collections, papers), [collections, papers]);
  const collectionNames = useMemo(() => new Map(collections.map((item) => [item.id, item.name])), [collections]);
  const papersByCollection = useMemo(() => {
    const map = new Map<string, LibraryPaper[]>();
    for (const paper of papers) for (const collectionId of paper.collectionIds) map.set(collectionId, [...(map.get(collectionId) ?? []), paper]);
    for (const items of map.values()) items.sort((left, right) => left.title.localeCompare(right.title));
    return map;
  }, [papers]);
  const uncategorizedCount = papers.filter((paper) => paper.collectionIds.length === 0).length;

  useEffect(() => {
    if (initialExpansionApplied.current || !collections.length) return;
    initialExpansionApplied.current = true;
    setExpanded(new Set(collections.filter((item) => !item.parentId).map((item) => item.id)));
  }, [collections]);

  useEffect(() => window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth)), [sidebarWidth]);
  useEffect(() => window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed)), [collapsed]);

  const resizeSidebar = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = sidebarDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setSidebarWidth(clampSidebarWidth(drag.startWidth + event.clientX - drag.startX));
  };
  const finishSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (sidebarDrag.current?.pointerId !== event.pointerId) return;
    sidebarDrag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const resizeSidebarWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setSidebarWidth((current) => clampSidebarWidth(current + (event.key === "ArrowRight" ? 16 : -16)));
  };

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["collections", root] }),
      queryClient.invalidateQueries({ queryKey: ["papers", root] }),
    ]);
  };
  const run = async (id: string, action: () => Promise<void>) => {
    setBusy(id);
    setNotice(null);
    try {
      await action();
      await refresh();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy("");
    }
  };
  const goLibrary = (filter: "all" | "ready", collectionId?: string) => {
    setStatusFilter(filter);
    setSelectedCollectionId(collectionId);
    setView("library");
  };
  const openCreate = (parentId?: string) => {
    if (parentId) setExpanded((current) => new Set(current).add(parentId));
    setEditor({ mode: "create", parentId, name: "", color: colors[collections.length % colors.length] });
    setNotice(null);
  };
  const openRename = (collection: LibraryCollection) => {
    setEditor({ mode: "rename", collection, parentId: collection.parentId, name: collection.name, color: collection.color });
    setNotice(null);
  };
  const saveEditor = (event: FormEvent) => {
    event.preventDefault();
    if (!editor?.name.trim()) return;
    void run("editor", async () => {
      if (editor.mode === "create") {
        const created = await createCollection(root, { name: editor.name.trim(), parentId: editor.parentId, color: editor.color });
        if (editor.parentId) setExpanded((current) => new Set(current).add(editor.parentId!));
        setSelectedCollectionId(created.id);
      } else if (editor.collection) {
        await updateCollection(root, editor.collection.id, { name: editor.name.trim(), color: editor.color });
      }
      setEditor(null);
    });
  };
  const remove = (collection: CollectionTreeNode) => {
    const suffix = collection.children.length ? "其全部子分类和归组关系也会移除，但不会删除论文文件。" : "归组关系会移除，但不会删除论文文件。";
    if (!window.confirm(`删除分类“${collection.name}”？${suffix}`)) return;
    void run(`delete:${collection.id}`, async () => {
      await deleteCollection(root, collection.id);
      if (selectedCollectionId && collectionScopeIds(collections, collection.id).has(selectedCollectionId)) setSelectedCollectionId(undefined);
    });
  };
  const dropItem = (event: ReactDragEvent, collectionId?: string) => {
    event.preventDefault();
    const collectionToMove = event.dataTransfer.getData("application/x-p2i-collection-id");
    if (collectionToMove) {
      setDropTarget("");
      if (collectionToMove === collectionId) return;
      const moving = collections.find((item) => item.id === collectionToMove);
      const destination = collectionId ? collectionNames.get(collectionId) ?? "所选分类" : "分类根目录";
      if (!moving) return;
      void run(`move-collection:${collectionToMove}`, async () => {
        await updateCollection(root, collectionToMove, { parentId: collectionId ?? null });
        setNotice({ kind: "success", text: `文件夹“${moving.name}”已移动到${destination}` });
      });
      return;
    }
    const paperId = event.dataTransfer.getData("application/x-p2i-paper-id") || event.dataTransfer.getData("text/plain");
    setDropTarget("");
    if (!paperId || !papers.some((paper) => paper.id === paperId)) return;
    const paper = papers.find((item) => item.id === paperId)!;
    const destination = collectionId ? collectionNames.get(collectionId) ?? "所选分类" : "未分类";
    void run(`move:${paperId}`, async () => {
      await movePaperToCollection(root, paperId, collectionId);
      setNotice({ kind: "success", text: `“${paper.title}”已移动到${destination}` });
    });
  };
  const allowDrop = (event: ReactDragEvent, target: string, hasChildren = false) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTarget(target);
    if (hasChildren) setExpanded((current) => new Set(current).add(target));
  };

  const startCollectionDrag = (event: ReactDragEvent, collectionId: string) => {
    setDraggingCollectionId(collectionId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-p2i-collection-id", collectionId);
    event.dataTransfer.setData("text/plain", collectionId);
  };

  const renderEditor = (parentId?: string, collectionId?: string) => editor && (
    editor.mode === "create" ? editor.parentId === parentId && !collectionId : editor.collection?.id === collectionId
  ) ? <form className="collection-inline-editor" onSubmit={saveEditor}>
    <input autoFocus maxLength={120} value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} placeholder={editor.mode === "create" ? "分类名称" : "重命名分类"} aria-label="分类名称" />
    <div className="collection-color-picker" aria-label="分类颜色">{colors.map((color) => <button type="button" key={color} className={editor.color === color ? "active" : ""} style={{ background: color }} onClick={() => setEditor({ ...editor, color })} title={color} />)}</div>
    <button className="collection-editor-save" type="submit" disabled={!editor.name.trim() || busy === "editor"} title="保存"><Check size={12} /></button>
    <button type="button" onClick={() => setEditor(null)} title="取消"><X size={12} /></button>
  </form> : null;

  const renderNode = (node: CollectionTreeNode, depth: number): ReactNode => {
    const isExpanded = expanded.has(node.id);
    const directPapers = papersByCollection.get(node.id) ?? [];
    const canExpand = node.children.length > 0 || directPapers.length > 0;
    const active = view === "library" && selectedCollectionId === node.id;
    return <div className="collection-tree-node" key={node.id}>
      <div draggable className={`collection-tree-row ${active ? "active" : ""} ${dropTarget === node.id ? "drop-target" : ""} ${draggingCollectionId === node.id ? "dragging" : ""}`} style={{ paddingLeft: `${8 + depth * 14}px` }} onDragStart={(event) => startCollectionDrag(event, node.id)} onDragEnd={() => { setDraggingCollectionId(""); setDropTarget(""); }} onDragOver={(event) => allowDrop(event, node.id, canExpand)} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropTarget(""); }} onDrop={(event) => dropItem(event, node.id)}>
        <button className="collection-expand" onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next; })} disabled={!canExpand} title={isExpanded ? "折叠" : "展开"}><ChevronRight size={13} className={isExpanded ? "expanded" : ""} /></button>
        <button className="collection-main" onClick={() => goLibrary("all", node.id)} title={`${node.name} · ${node.totalPaperCount} 篇论文`}>{isExpanded && canExpand ? <FolderOpen size={15} style={{ color: node.color }} /> : <Folder size={15} style={{ color: node.color }} />}<span>{node.name}</span><b>{node.totalPaperCount}</b></button>
        <div className="collection-actions"><span title="拖动文件夹改变层级"><GripVertical size={12} /></span><button onClick={() => openCreate(node.id)} title="新建子分类"><FolderPlus size={12} /></button><button onClick={() => openRename(node)} title="重命名"><Pencil size={12} /></button><button onClick={() => remove(node)} disabled={busy === `delete:${node.id}`} title="删除"><Trash2 size={12} /></button></div>
      </div>
      {renderEditor(node.parentId, node.id)}
      {isExpanded && <div className="collection-tree-children">{node.children.map((child) => renderNode(child, depth + 1))}{directPapers.map((paper) => <button draggable key={paper.id} className={`collection-paper-leaf ${selectedPaperId === paper.id ? "selected" : ""}`} style={{ paddingLeft: `${32 + (depth + 1) * 14}px` }} title={`${paper.title}\n双击打开，或拖动到其他分类`} onClick={() => { selectPaper(paper.id); setView("library"); }} onDoubleClick={() => openReader(paper.id)} onDragStart={(event) => { selectPaper(paper.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-p2i-paper-id", paper.id); event.dataTransfer.setData("text/plain", paper.id); }}><FileText size={13} /><span>{paper.title}</span></button>)}{renderEditor(node.id)}</div>}
    </div>;
  };

  const renderedWidth = collapsed ? COLLAPSED_SIDEBAR_WIDTH : sidebarWidth;
  return <aside className={`research-sidebar ${collapsed ? "collapsed" : ""}`} style={{ width: renderedWidth, flexBasis: renderedWidth }}>
    <div className="sidebar-panel-controls"><button title={collapsed ? "展开左侧栏" : "收起左侧栏"} onClick={() => setCollapsed((value) => !value)}>{collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}<span>{collapsed ? "" : "导航"}</span></button></div>
    <div className="sidebar-scroll">
      <button className={`research-nav-item ${view === "library" && statusFilter === "all" && !selectedCollectionId ? "active" : ""}`} onClick={() => goLibrary("all")}><BookOpen size={14} /><span>全部论文</span><b>{papers.length}</b></button>
      <button className="research-nav-item" onClick={() => goLibrary("ready")}><Star size={14} /><span>已收藏</span><b>{Math.min(4, papers.length)}</b></button>
      <button className="research-nav-item" onClick={() => goLibrary("all")}><Clock3 size={14} /><span>最近添加</span></button>
      <button className={`research-nav-item ${view === "reader" ? "active" : ""}`} onClick={() => setView("reader")}><BookOpen size={14} /><span>正在阅读</span><b>{papers.length ? 1 : 0}</b></button>
      <button className="research-nav-item" onClick={() => goLibrary("all")}><Inbox size={14} /><span>收件箱 / 未读</span></button>

      <div className="sidebar-divider" />
      <div className={`sidebar-section-title collection-root-drop ${dropTarget === "__root__" ? "drop-target" : ""}`} onDragOver={(event) => allowDrop(event, "__root__")} onDragLeave={() => setDropTarget("")} onDrop={(event) => dropItem(event)} title="把文件夹拖到这里可移到分类根目录"><span>分类</span><button title="新建分类" onClick={() => openCreate()}><Plus size={12} /></button></div>
      <div className="collection-tree" aria-label="论文分类树">{tree.map((node) => renderNode(node, 0))}{renderEditor(undefined)}{!tree.length && !editor && <button className="collection-empty" onClick={() => openCreate()}><FolderPlus size={16} /><span>新建第一个分类</span></button>}
        <div className={`collection-tree-row uncategorized ${selectedCollectionId === "__uncategorized__" ? "active" : ""} ${dropTarget === "__uncategorized__" ? "drop-target" : ""}`} onDragOver={(event) => allowDrop(event, "__uncategorized__")} onDragLeave={() => setDropTarget("")} onDrop={(event) => dropItem(event)}><span className="collection-expand" /><button className="collection-main" onClick={() => goLibrary("all", "__uncategorized__")}><Inbox size={14} /><span>未分类</span><b>{uncategorizedCount}</b></button></div>
      </div>
      {notice && <div className={`collection-notice ${notice.kind}`}>{notice.kind === "success" ? <Check size={12} /> : <TriangleAlert size={12} />}<span>{notice.text}</span><button onClick={() => setNotice(null)}><X size={11} /></button></div>}

      <div className="sidebar-divider" />
      <div className="sidebar-section-title"><span>智能体</span></div>
      {[["论文分析", "#4f6bed"], ["翻译", "#3984d8"], ["图表分析", "#7357d8"], ["创新分析", "#28a06a"]].map(([name, color], index) => <button className={`agent-row ${view === "agents" && index === 0 ? "active" : ""}`} key={name} onClick={() => setView("agents")}><i style={{ background: color }} /><span>{name}</span>{index === 0 && <em />}</button>)}

      <div className="sidebar-divider" />
      <div className="sidebar-section-title"><span>本地工具</span></div>
      <button className={`research-nav-item ${view === "jobs" ? "active" : ""}`} onClick={() => setView("jobs")}><History size={14} /><span>任务活动</span></button>
      <button className={`research-nav-item ${view === "import" ? "active" : ""}`} onClick={() => setView("import")}><FolderInput size={14} /><span>导入 Zotero</span></button>
    </div>
    <footer className="sidebar-footer"><button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")} title="模型与处理"><Bot size={14} /></button><button className={view === "security" ? "active" : ""} onClick={() => setView("security")} title="安全与应用"><Settings2 size={14} /></button><button className={view === "graph" ? "active" : ""} onClick={() => setView("graph")} title="引用图谱"><Network size={14} /></button><button className={view === "context" ? "active" : ""} onClick={() => setView("context")} title="上下文工作区"><Layers3 size={14} /></button><span><Users size={12} /> 本地</span></footer>
    {!collapsed && <div className="sidebar-panel-resizer" role="separator" aria-label="调整左侧栏宽度" aria-orientation="vertical" aria-valuemin={MIN_SIDEBAR_WIDTH} aria-valuemax={MAX_SIDEBAR_WIDTH} aria-valuenow={sidebarWidth} tabIndex={0} title="拖动调整左侧栏宽度" onPointerDown={(event) => { event.preventDefault(); event.currentTarget.focus(); sidebarDrag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: sidebarWidth }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={resizeSidebar} onPointerUp={finishSidebarResize} onPointerCancel={finishSidebarResize} onKeyDown={resizeSidebarWithKeyboard} />}
  </aside>;
}
