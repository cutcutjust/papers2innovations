import type { LibraryPaper } from "@p2i/contracts";
import { FileText, MoreHorizontal } from "lucide-react";
import { Status } from "./Status";
import { useWorkspace } from "../store";

export function PaperList({ papers }: { papers: LibraryPaper[] }) {
  const { selectedPaperId, selectPaper, statusFilter, setStatusFilter } = useWorkspace();
  const counts = {
    all: papers.length,
    ready: papers.filter((paper) => paper.status === "READY").length,
    processing: papers.filter((paper) => !["READY", "FAILED", "MISSING", "CANCELLED"].includes(paper.status)).length,
    issues: papers.filter((paper) => ["FAILED", "MISSING", "CANCELLED"].includes(paper.status)).length,
  };
  return (
    <section className="paper-panel" aria-label="Paper library">
      <div className="panel-heading">
        <div>
          <h1>Library</h1>
          <p>{papers.length} local papers</p>
        </div>
        <button className="icon-button small" title="Library actions"><MoreHorizontal size={17} /></button>
      </div>
      <div className="filter-tabs" role="tablist">
        {(["all", "ready", "processing", "issues"] as const).map((filter) => (
          <button
            key={filter}
            className={statusFilter === filter ? "active" : ""}
            onClick={() => setStatusFilter(filter)}
          >
            {filter[0].toUpperCase() + filter.slice(1)} <span>{counts[filter]}</span>
          </button>
        ))}
      </div>
      <div className="paper-list">
        {papers.map((paper) => (
          <button
            key={paper.id}
            className={`paper-row ${selectedPaperId === paper.id ? "selected" : ""}`}
            onClick={() => selectPaper(paper.id)}
          >
            <span className="paper-file-icon"><FileText size={18} /></span>
            <span className="paper-row-body">
              <strong>{paper.title}</strong>
              <span className="paper-path">{paper.sourcePath}</span>
              <span className="paper-row-meta">
                <Status status={paper.status} />
                {paper.pageCount > 0 && <span>{paper.pageCount} pages</span>}
              </span>
              {paper.progress > 0 && paper.progress < 1 && (
                <span className="row-progress"><i style={{ width: `${paper.progress * 100}%` }} /></span>
              )}
            </span>
          </button>
        ))}
        {papers.length === 0 && (
          <div className="empty-list"><FileText size={28} /><p>No papers match this view.</p></div>
        )}
      </div>
    </section>
  );
}

