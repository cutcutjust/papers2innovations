import type { JobStatus } from "@p2i/contracts";
import { AlertCircle, CheckCircle2, Clock3, FileQuestion } from "lucide-react";

const labels: Partial<Record<JobStatus, string>> = {
  READY: "Ready",
  FAILED: "Needs attention",
  MISSING: "Missing",
  CANCELLED: "Cancelled",
  PARSING_LAYOUT: "Parsing layout",
  EXTRACTING_FIGURES: "Extracting figures",
  HASHING: "Hashing",
  QUEUED: "Queued",
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

