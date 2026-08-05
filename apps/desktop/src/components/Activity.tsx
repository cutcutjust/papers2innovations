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
  const stageLabels: Record<string, string> = { hash: "文件校验", render: "页面渲染", layout: "版面分析", vision_text: "视觉识别", ocr: "文字识别", figures: "插图", tables: "表格", formulas: "公式", cleanup: "文档整理", verification: "原文复核", index: "建立索引" };
  const stageState = (status: string) => {
    const value = status.toLowerCase();
    if (value === "ready" || value === "completed") return { className: "done", label: "完成" };
    if (value === "partial") return { className: "partial", label: "部分完成" };
    if (value === "failed") return { className: "failed", label: "失败" };
    if (value === "unknown") return { className: "unknown", label: "状态未知" };
    if (value === "cancelled") return { className: "cancelled", label: "已取消" };
    if (value === "pending" || value === "queued") return { className: "pending", label: "等待中" };
    return { className: "active", label: "进行中" };
  };
  return (
    <main className="activity-page">
      <div className="activity-header"><ActivityIcon size={21} /><div><h1>任务活动</h1><p>持久化的导入与解析状态</p></div></div>
      {loading && <div className="inline-loading"><RefreshCw className="spin" size={16} /> 正在加载任务...</div>}
      {error && <div className="notice error-notice"><FileText size={18} /><div><strong>任务列表不可用</strong><p>{error.message}</p>{onRetry && <button className="secondary-button" onClick={onRetry}><RefreshCw size={14} /> 重试</button>}</div></div>}
      <div className="job-list">
        {jobs.map((job) => {
          const paper = job.paper_id ? paperById.get(job.paper_id) : undefined;
          const terminal = ["READY", "PARTIAL", "FAILED", "CANCELLED"].includes(job.status);
          const regionArtifact = [...job.stages].reverse().map((stage) => stage.artifact).find((artifact) => Number(artifact.totalRegionCount ?? 0) > 0);
          const completedRegions = Number(regionArtifact?.completedRegionCount ?? 0);
          const totalRegions = Number(regionArtifact?.totalRegionCount ?? 0);
          const failedRegions = Number(regionArtifact?.failedRegionCount ?? 0);
          const unknownRegions = Number(regionArtifact?.unknownRegionCount ?? 0);
          const recognizedPages = Number(regionArtifact?.recognizedPageCount ?? 0);
          const failedPages = Number(regionArtifact?.failedPageCount ?? 0);
          const durationMs = Number(regionArtifact?.durationMs ?? 0);
          return <section className="job-record" key={job.id}>
            <div className="job-summary">
              <span className="activity-paper"><FileText size={16} /><span><strong>{paper?.title ?? "论文任务"}</strong><small>{job.message}</small></span></span>
              <Status status={job.status as JobStatus} />
              <span className="job-percent">{job.status === "FAILED" ? "未完成" : job.status === "PARTIAL" ? "部分完成" : `${Math.round(job.progress * 100)}%`}</span>
              <div className="job-actions">
                {!terminal && <button className="icon-button small" title="取消任务" onClick={() => action.mutate({ kind: "cancel", id: job.id })}><Square size={14} /></button>}
                {["FAILED", "CANCELLED", "PARTIAL"].includes(job.status) && <button className="icon-button small" title="重试任务" onClick={() => action.mutate({ kind: "retry", id: job.id })}><RefreshCw size={14} /></button>}
              </div>
            </div>
            {totalRegions > 0 && <div className="job-region-summary"><span><strong>{completedRegions}/{totalRegions}</strong> 区域完成</span><span><strong>{recognizedPages}</strong> 页成功{failedPages > 0 ? ` / ${failedPages} 页失败` : ""}</span>{failedRegions > 0 && <span className="failed"><strong>{failedRegions}</strong> 区域失败</span>}{unknownRegions > 0 && <span className="unknown"><strong>{unknownRegions}</strong> 费用状态未知</span>}{durationMs > 0 && <span>{(durationMs / 1000).toFixed(1)} 秒</span>}{Boolean(regionArtifact?.visionModelId) && <span>{String(regionArtifact?.visionModelId)}</span>}</div>}
            <div className="stage-strip">{job.stages.map((stage) => { const state = stageState(String(stage.status)); return <div className={`stage-chip ${state.className}`} key={stage.id}><i /><span>{stageLabels[stage.stage] ?? stage.stage}</span><small>{state.label}{state.className === "active" ? ` ${Math.round(stage.progress * 100)}%` : ""}</small></div>; })}</div>
            {job.error && <p className="job-error">{job.error}</p>}
          </section>;
        })}
      </div>
    </main>
  );
}
