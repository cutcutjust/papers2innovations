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
        <div><h1>Library</h1><p>{allPapers.length} papers · Local research library</p></div>
        <div className="page-actions">
          <button className="secondary-button"><Upload size={14} /> Add PDF</button>
          <button className="primary-button compact" onClick={onChooseLibrary}><FolderOpen size={14} /> Open Paper Folder</button>
        </div>
      </header>
      <div className="library-toolbar">
        <label className="figma-input library-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search within library" /></label>
        <button><Filter size={13} /> Filters</button><button><SortAsc size={13} /> Sort</button><button><Layers3 size={13} /> Group</button>
        <button onClick={onScan} disabled={scanning}><RefreshCw size={13} className={scanning ? "spin" : ""} /> Scan</button>
        <div className="view-switch"><button className="active" title="Table view"><List size={13} /></button><button title="Grid view"><Grid2X2 size={13} /></button></div>
      </div>
      <div className="library-surface">
        <section className="paper-table-wrap">
          <div className="paper-table-head"><span>Title</span><span>Status</span><span>Pages</span><span>Updated</span><span /></div>
          <div className="figma-paper-table">
            {papers.map((paper, index) => (
              <button key={paper.id} className={`figma-paper-row ${selectedPaperId === paper.id ? "selected" : ""}`} onClick={() => selectPaper(paper.id)} onDoubleClick={() => openReader(paper.id)}>
                <span className="paper-title-cell"><span className="paper-doc-icon"><FileText size={15} /></span><span><strong>{paper.title}</strong><small>{paper.sourcePath}</small><em>{index % 3 === 0 ? "Foundation Models" : index % 3 === 1 ? "Multimodal" : "Local Library"}</em></span></span>
                <span><Status status={paper.status} /></span>
                <span className="mono-cell">{paper.pageCount || "—"}</span>
                <span>{new Date(paper.updatedAt).toLocaleDateString()}</span>
                <span><MoreHorizontal size={15} /></span>
              </button>
            ))}
            {!papers.length && <div className="empty-table"><FileText size={28} /><strong>No papers match this view</strong><span>Try changing the search text or library filter.</span></div>}
          </div>
        </section>
        <aside className="library-inspector">
          {!selected ? <div className="empty-inspector"><BookOpen size={30} /><span>Select a paper to inspect it</span></div> : <>
            <div className="paper-preview"><div><i /><i /><i /><b /></div></div>
            <div className="inspector-content">
              <div className="inspector-tags"><span className="tag tag-primary">LOCAL PAPER</span><Status status={selected.status} /></div>
              <h2>{selected.title}</h2><p className="inspector-source">{selected.sourcePath}</p>
              {selected.progress > 0 && selected.progress < 1 && <div className="figma-progress"><i style={{ width: `${selected.progress * 100}%` }} /></div>}
              <dl className="paper-facts"><div><dt>Markdown</dt><dd>{selected.markdownPath ? "Available" : "Pending"}</dd></div><div><dt>Figures</dt><dd>{selected.figures.length}</dd></div><div><dt>Pages</dt><dd>{selected.pageCount || "—"}</dd></div><div><dt>Updated</dt><dd>{new Date(selected.updatedAt).toLocaleDateString()}</dd></div></dl>
              <div className="inspector-actions"><button className="primary-button compact" onClick={() => openReader(selected.id)}><BookOpen size={13} /> Open in Reader</button><button className="secondary-button" onClick={() => useWorkspace.getState().setView("context")}><Layers3 size={13} /> Add to Context</button><button className="secondary-button"><CheckCircle2 size={13} /> Export Citation <ChevronRight size={12} /></button></div>
            </div>
          </>}
        </aside>
      </div>
    </div>
  );
}
