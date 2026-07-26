import type { JobStatus, LibraryPaper } from "@p2i/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Activity as ActivityIcon, FileText, RefreshCw, Square } from "lucide-react";
import type { JobRecord } from "../lib/bridge";
import { cancelJob, retryJob } from "../lib/bridge";
import { Status } from "./Status";

export function Activity({ papers, jobs, root, loading = false, error, onRetry }: { papers: LibraryPaper[]; jobs: JobRecord[]; root: string; loading?: boolean; error?: Error | null; onRetry?: () => void }) {
  const queryClient = useQueryClient();
  const action = useMutation({
    mutationFn: ({ kind, id }: { kind: "cancel" | "retry"; id: string }) => kind === "cancel" ? cancelJob(root, id) : retryJob(root, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["jobs", root] }),
  });
  const paperById = new Map(papers.map((paper) => [paper.id, paper]));
  return (
    <main className="activity-page">
      <div className="activity-header"><ActivityIcon size={21} /><div><h1>Activity</h1><p>Persisted ingestion and parse state</p></div></div>
      {loading && <div className="inline-loading"><RefreshCw className="spin" size={16} /> Loading activity...</div>}
      {error && <div className="notice error-notice"><FileText size={18} /><div><strong>Activity unavailable</strong><p>{error.message}</p>{onRetry && <button className="secondary-button" onClick={onRetry}><RefreshCw size={14} /> Retry</button>}</div></div>}
      <div className="job-list">
        {jobs.map((job) => {
          const paper = job.paper_id ? paperById.get(job.paper_id) : undefined;
          const terminal = ["READY", "PARTIAL", "FAILED", "CANCELLED"].includes(job.status);
          return <section className="job-record" key={job.id}>
            <div className="job-summary">
              <span className="activity-paper"><FileText size={16} /><span><strong>{paper?.title ?? "Paper job"}</strong><small>{job.message}</small></span></span>
              <Status status={job.status as JobStatus} />
              <span className="job-percent">{Math.round(job.progress * 100)}%</span>
              <div className="job-actions">
                {!terminal && <button className="icon-button small" title="Cancel job" onClick={() => action.mutate({ kind: "cancel", id: job.id })}><Square size={14} /></button>}
                {["FAILED", "CANCELLED", "PARTIAL"].includes(job.status) && <button className="icon-button small" title="Retry job" onClick={() => action.mutate({ kind: "retry", id: job.id })}><RefreshCw size={14} /></button>}
              </div>
            </div>
            <div className="stage-strip">{job.stages.map((stage) => <div className={`stage-chip ${stage.progress >= 1 ? "done" : ""}`} key={stage.id}><i /><span>{stage.stage}</span><small>{stage.progress >= 1 ? "done" : `${Math.round(stage.progress * 100)}%`}</small></div>)}</div>
            {job.error && <p className="job-error">{job.error}</p>}
          </section>;
        })}
      </div>
    </main>
  );
}
