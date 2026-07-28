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
      <div className="activity-header"><ActivityIcon size={21} /><div><h1>任务活动</h1><p>持久化的导入与解析状态</p></div></div>
      {loading && <div className="inline-loading"><RefreshCw className="spin" size={16} /> 正在加载任务...</div>}
      {error && <div className="notice error-notice"><FileText size={18} /><div><strong>任务列表不可用</strong><p>{error.message}</p>{onRetry && <button className="secondary-button" onClick={onRetry}><RefreshCw size={14} /> 重试</button>}</div></div>}
      <div className="job-list">
        {jobs.map((job) => {
          const paper = job.paper_id ? paperById.get(job.paper_id) : undefined;
          const terminal = ["READY", "PARTIAL", "FAILED", "CANCELLED"].includes(job.status);
          return <section className="job-record" key={job.id}>
            <div className="job-summary">
              <span className="activity-paper"><FileText size={16} /><span><strong>{paper?.title ?? "论文任务"}</strong><small>{job.message}</small></span></span>
              <Status status={job.status as JobStatus} />
              <span className="job-percent">{Math.round(job.progress * 100)}%</span>
              <div className="job-actions">
                {!terminal && <button className="icon-button small" title="取消任务" onClick={() => action.mutate({ kind: "cancel", id: job.id })}><Square size={14} /></button>}
                {["FAILED", "CANCELLED", "PARTIAL"].includes(job.status) && <button className="icon-button small" title="重试任务" onClick={() => action.mutate({ kind: "retry", id: job.id })}><RefreshCw size={14} /></button>}
              </div>
            </div>
            <div className="stage-strip">{job.stages.map((stage) => <div className={`stage-chip ${stage.progress >= 1 ? "done" : ""}`} key={stage.id}><i /><span>{stage.stage}</span><small>{stage.progress >= 1 ? "完成" : `${Math.round(stage.progress * 100)}%`}</small></div>)}</div>
            {job.error && <p className="job-error">{job.error}</p>}
          </section>;
        })}
      </div>
    </main>
  );
}
