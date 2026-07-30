import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronUp, CircleAlert, LoaderCircle, X } from "lucide-react";
import type { ModelActivityPhase, ModelActivityState } from "@p2i/contracts";
import { listen } from "@tauri-apps/api/event";
import type { ModelHostActivityEvent } from "@p2i/contracts";
import { nativeRuntime } from "../lib/bridge";
import { useModelActivity } from "../lib/modelActivity";

const phaseLabels: Record<ModelActivityPhase, string> = {
  preparing: "正在准备请求",
  sending: "正在连接模型",
  connected: "模型接口已连接",
  streaming: "已收到响应，正在生成",
  saving: "正在校验并保存",
  completed: "模型调用完成",
  cancelled: "已取消",
  error: "模型调用失败",
};

const phaseStep: Record<ModelActivityPhase, number> = {
  preparing: 0,
  sending: 1,
  connected: 2,
  streaming: 3,
  saving: 4,
  completed: 5,
  cancelled: 1,
  error: 1,
};

function elapsed(activity: ModelActivityState, now: number) {
  const end = activity.completedAt ?? now;
  return Math.max(0, (end - activity.startedAt) / 1000).toFixed(1);
}

export function ModelActivityCenter() {
  const activities = useModelActivity((state) => state.activities);
  const applyHostEvent = useModelActivity((state) => state.applyHostEvent);
  const dismiss = useModelActivity((state) => state.dismiss);
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(Date.now());
  const ordered = useMemo(() => {
    const groups = new Map<string, ModelActivityState[]>();
    for (const activity of Object.values(activities)) {
      const key = activity.groupKey ?? activity.requestId;
      groups.set(key, [...(groups.get(key) ?? []), activity]);
    }
    return [...groups.entries()].map(([key, members]) => {
      const latest = [...members].sort((left, right) => right.startedAt - left.startedAt)[0];
      if (members.length === 1) return { ...latest, memberIds: [latest.requestId] };
      const active = members.find((activity) => !["completed", "cancelled", "error"].includes(activity.phase));
      const failed = members.find((activity) => activity.phase === "error");
      const completedItems = members.filter((activity) => ["completed", "cancelled", "error"].includes(activity.phase)).length;
      const totalItems = Math.max(members.length, ...members.map((activity) => activity.totalItems ?? 0));
      return {
        ...latest,
        requestId: `group:${key}`,
        memberIds: members.map((activity) => activity.requestId),
        phase: active ? active.phase : failed ? "error" as const : completedItems < totalItems ? "sending" as const : "completed" as const,
        startedAt: Math.min(...members.map((activity) => activity.startedAt)),
        completedAt: active ? undefined : Math.max(...members.map((activity) => activity.completedAt ?? activity.startedAt)),
        receivedCharacters: members.reduce((total, activity) => total + activity.receivedCharacters, 0),
        completedItems,
        totalItems,
        usage: members.reduce((usage, activity) => ({ inputTokens: usage.inputTokens + (activity.usage?.inputTokens ?? 0), outputTokens: usage.outputTokens + (activity.usage?.outputTokens ?? 0) }), { inputTokens: 0, outputTokens: 0 }),
        error: failed?.error,
      };
    }).sort((left, right) => right.startedAt - left.startedAt);
  }, [activities]);

  useEffect(() => {
    if (!ordered.some((activity) => !activity.completedAt)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [ordered]);

  useEffect(() => {
    if (!nativeRuntime) return;
    let unlisten = () => {};
    void listen<ModelHostActivityEvent>("model-host-activity", (event) => applyHostEvent(event.payload)).then((cleanup) => { unlisten = cleanup; });
    return () => unlisten();
  }, [applyHostEvent]);

  useEffect(() => {
    const completedGroups = ordered.filter((activity) => activity.memberIds.length > 1 && activity.totalItems && activity.completedItems === activity.totalItems && ["completed", "cancelled"].includes(activity.phase));
    if (!completedGroups.length) return;
    const timer = window.setTimeout(() => completedGroups.forEach((activity) => activity.memberIds.forEach(dismiss)), 5000);
    return () => window.clearTimeout(timer);
  }, [dismiss, ordered]);

  if (!ordered.length) return null;
  const activeCount = ordered.filter((activity) => !["completed", "cancelled", "error"].includes(activity.phase)).length;
  return <aside className={`model-activity-center ${collapsed ? "collapsed" : ""}`} aria-live="polite" aria-label="AI 模型调用状态">
    <header>
      <span><LoaderCircle className={activeCount ? "spin" : ""} size={16} /></span>
      <div><strong>{activeCount ? `${activeCount} 个 AI 任务进行中` : "AI 调用状态"}</strong><small>{ordered.length > 1 ? `${ordered.length} 条最近活动` : ordered[0].label}</small></div>
      <button className="icon-button" title={collapsed ? "展开模型活动" : "收起模型活动"} onClick={() => setCollapsed((value) => !value)}>{collapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</button>
    </header>
    {!collapsed && <div className="model-activity-list">{ordered.map((activity) => {
      const terminal = ["completed", "cancelled", "error"].includes(activity.phase);
      const usage = activity.usage ? `${activity.usage.inputTokens.toLocaleString()} 输入 / ${activity.usage.outputTokens.toLocaleString()} 输出 tokens` : "";
      return <article className={`model-activity-item ${activity.phase}`} key={activity.requestId}>
        <div className="model-activity-heading">
          <span className="model-activity-icon">{activity.phase === "completed" ? <CheckCircle2 size={15} /> : activity.phase === "error" ? <CircleAlert size={15} /> : <LoaderCircle className={terminal ? "" : "spin"} size={15} />}</span>
          <div><strong>{activity.label}</strong><small>{activity.modelName}</small></div>
          {terminal && <button className="icon-button" title="关闭" onClick={() => activity.memberIds.forEach(dismiss)}><X size={13} /></button>}
        </div>
        <div className="model-activity-stage"><span>{phaseLabels[activity.phase]}</span><b>{elapsed(activity, now)} 秒</b></div>
        <div className="model-activity-progress" aria-label={phaseLabels[activity.phase]}>{[1, 2, 3, 4, 5].map((step) => <i className={step <= phaseStep[activity.phase] ? "done" : step === phaseStep[activity.phase] + 1 && !terminal ? "active" : ""} key={step} />)}</div>
        {(activity.receivedCharacters > 0 || usage || activity.totalItems) && <footer><span>{activity.totalItems ? `已完成 ${activity.completedItems ?? 0} / ${activity.totalItems}` : activity.receivedCharacters > 0 ? `已接收 ${activity.receivedCharacters.toLocaleString()} 字符` : ""}</span><span>{usage}</span></footer>}
        {activity.error && <p>{activity.error}</p>}
      </article>;
    })}</div>}
  </aside>;
}
