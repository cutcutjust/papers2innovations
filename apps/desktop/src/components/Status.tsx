import type { JobStatus } from "@p2i/contracts";
import { AlertCircle, CheckCircle2, Clock3, FileQuestion } from "lucide-react";

const labels: Partial<Record<JobStatus, string>> = {
  READY: "已完成",
  FAILED: "需要处理",
  MISSING: "文件缺失",
  CANCELLED: "已取消",
  PARSING_LAYOUT: "解析版面",
  EXTRACTING_FIGURES: "提取图表",
  HASHING: "计算哈希",
  QUEUED: "等待处理",
};

export function Status({ status }: { status: JobStatus }) {
  const failed = status === "FAILED" || status === "CANCELLED";
  const missing = status === "MISSING";
  const ready = status === "READY";
  const Icon = ready ? CheckCircle2 : failed ? AlertCircle : missing ? FileQuestion : Clock3;
  return (
    <span className={`status status-${ready ? "ready" : failed ? "error" : missing ? "missing" : "working"}`}>
      <Icon size={13} strokeWidth={2} />
      {labels[status] ?? status.toLowerCase().replaceAll("_", " ")}
    </span>
  );
}
