import type { LibraryPaper } from "@p2i/contracts";
import { Check, ChevronRight, CircleDashed, FileCode2, FileText, Image, ShieldCheck } from "lucide-react";

const stages = ["Discovered", "SHA-256 verified", "Layout parsed", "Figures extracted", "Artifacts indexed"];

export function Inspector({ paper }: { paper?: LibraryPaper }) {
  return (
    <aside className="inspector">
      <div className="inspector-heading"><span>Artifacts</span><ShieldCheck size={16} /></div>
      {!paper ? <p className="muted">Select a paper to inspect its processing record.</p> : (
        <>
          <div className="artifact-list">
            <button><FileText size={16} /><span><strong>paper.md</strong><small>Reading view</small></span><ChevronRight size={14} /></button>
            <button><FileCode2 size={16} /><span><strong>document.json</strong><small>Structured source</small></span><ChevronRight size={14} /></button>
            <button><Image size={16} /><span><strong>figures/</strong><small>{paper.figures.length} extracted</small></span><ChevronRight size={14} /></button>
          </div>
          <div className="inspector-heading second"><span>Parse record</span><span className="record-id">#{paper.id.slice(0, 6)}</span></div>
          <ol className="stage-list">
            {stages.map((stage, index) => {
              const completed = paper.status === "READY" || index / stages.length < paper.progress;
              return <li key={stage} className={completed ? "completed" : ""}><span>{completed ? <Check size={12} /> : <CircleDashed size={13} />}</span>{stage}</li>;
            })}
          </ol>
          <div className="source-detail"><span>Source</span><p title={paper.sourcePath}>{paper.sourcePath}</p></div>
          <div className="integrity-note"><ShieldCheck size={15} /><p><strong>Content addressed</strong><br />This record is identified by SHA-256, not its file path.</p></div>
        </>
      )}
    </aside>
  );
}

