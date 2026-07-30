import type { ModelActivityMeta, ModelActivityState, ModelHostActivityEvent, ModelStreamEvent } from "@p2i/contracts";
import { create } from "zustand";

interface ModelActivityStore {
  activities: Record<string, ModelActivityState>;
  begin: (requestId: string, meta: ModelActivityMeta) => void;
  applyStreamEvent: (event: ModelStreamEvent) => void;
  applyHostEvent: (event: ModelHostActivityEvent) => void;
  markSaving: (requestId: string) => void;
  complete: (requestId: string, usage?: { inputTokens: number; outputTokens: number }) => void;
  fail: (requestId: string, error: string) => void;
  dismiss: (requestId: string) => void;
}

const terminalTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleDismiss(requestId: string, delay = 5000) {
  const current = terminalTimers.get(requestId);
  if (current) clearTimeout(current);
  terminalTimers.set(requestId, setTimeout(() => {
    useModelActivity.getState().dismiss(requestId);
    terminalTimers.delete(requestId);
  }, delay));
}

function updateActivity(requestId: string, update: (current: ModelActivityState) => ModelActivityState) {
  useModelActivity.setState((state) => {
    const current = state.activities[requestId];
    if (!current) return state;
    return { activities: { ...state.activities, [requestId]: update(current) } };
  });
}

export const useModelActivity = create<ModelActivityStore>((set, get) => ({
  activities: {},
  begin: (requestId, meta) => set((state) => ({
    activities: {
      ...state.activities,
      [requestId]: {
        ...meta,
        requestId,
        phase: "preparing",
        startedAt: Date.now(),
        receivedCharacters: 0,
      },
    },
  })),
  applyStreamEvent: (event) => {
    const current = get().activities[event.requestId];
    if (!current) return;
    const now = Date.now();
    if (event.kind === "started") {
      updateActivity(event.requestId, (activity) => ({ ...activity, phase: "sending" }));
    } else if (event.kind === "connected") {
      updateActivity(event.requestId, (activity) => ({ ...activity, phase: "connected", connectedAt: activity.connectedAt ?? now }));
    } else if (event.kind === "delta") {
      updateActivity(event.requestId, (activity) => ({
        ...activity,
        phase: "streaming",
        connectedAt: activity.connectedAt ?? now,
        firstTokenAt: activity.firstTokenAt ?? now,
        receivedCharacters: activity.receivedCharacters + (event.text?.length ?? 0),
      }));
    } else if (event.kind === "tool_calls") {
      updateActivity(event.requestId, (activity) => ({
        ...activity,
        phase: activity.deferCompletion ? "saving" : "completed",
        connectedAt: activity.connectedAt ?? now,
        completedAt: activity.deferCompletion ? undefined : now,
        usage: event.usage ?? activity.usage,
      }));
      if (!current.deferCompletion) scheduleDismiss(event.requestId);
    } else if (event.kind === "done") {
      updateActivity(event.requestId, (activity) => ({
        ...activity,
        phase: activity.deferCompletion ? "saving" : "completed",
        completedAt: activity.deferCompletion ? undefined : now,
        usage: event.usage ?? activity.usage,
      }));
      if (!current.deferCompletion) scheduleDismiss(event.requestId);
    } else if (event.kind === "cancelled") {
      updateActivity(event.requestId, (activity) => ({ ...activity, phase: "cancelled", completedAt: now }));
      scheduleDismiss(event.requestId, 3500);
    } else if (event.kind === "error") {
      updateActivity(event.requestId, (activity) => ({ ...activity, phase: "error", completedAt: now, error: event.error ?? "模型调用失败" }));
    }
  },
  applyHostEvent: (event) => {
    const activityId = `host-group:${event.source}:${event.modelName}`;
    const current = get().activities[activityId];
    if (!current) get().begin(activityId, { source: event.source, label: event.label, modelName: event.modelName, groupKey: `${event.source}:${event.modelName}`, totalItems: event.phase === "sending" ? 1 : 0 });
    const now = Date.now();
    updateActivity(activityId, (activity) => {
      const totalItems = (activity.totalItems ?? 0) + (event.phase === "sending" && current ? 1 : 0);
      const completedItems = (activity.completedItems ?? 0) + (["completed", "error"].includes(event.phase) ? 1 : 0);
      const finished = totalItems > 0 && completedItems >= totalItems;
      return {
        ...activity,
        totalItems,
        completedItems,
        phase: event.phase === "error" ? "error" : finished ? "completed" : event.phase === "completed" ? "streaming" : event.phase,
        connectedAt: event.phase === "connected" ? activity.connectedAt ?? now : activity.connectedAt,
        completedAt: finished || event.phase === "error" ? now : undefined,
        usage: event.usage ? {
          inputTokens: (activity.usage?.inputTokens ?? 0) + (event.usage.inputTokens ?? 0),
          outputTokens: (activity.usage?.outputTokens ?? 0) + (event.usage.outputTokens ?? 0),
        } : activity.usage,
        error: event.error,
      };
    });
    if (event.phase === "completed") {
      const updated = get().activities[activityId];
      if (updated?.phase === "completed") scheduleDismiss(activityId);
    }
  },
  markSaving: (requestId) => updateActivity(requestId, (activity) => ({ ...activity, phase: "saving" })),
  complete: (requestId, usage) => {
    const activity = get().activities[requestId];
    updateActivity(requestId, (activity) => ({ ...activity, phase: "completed", completedAt: Date.now(), usage: usage ?? activity.usage }));
    if (!activity?.totalItems || activity.totalItems <= 1) scheduleDismiss(requestId);
  },
  fail: (requestId, error) => updateActivity(requestId, (activity) => ({ ...activity, phase: "error", completedAt: Date.now(), error })),
  dismiss: (requestId) => set((state) => {
    const activities = { ...state.activities };
    delete activities[requestId];
    return { activities };
  }),
}));

export function beginModelActivity(requestId: string, meta: ModelActivityMeta) {
  useModelActivity.getState().begin(requestId, meta);
}

export function applyModelStreamEvent(event: ModelStreamEvent) {
  useModelActivity.getState().applyStreamEvent(event);
}

export function markModelActivitySaving(requestId: string) {
  useModelActivity.getState().markSaving(requestId);
}

export function completeModelActivity(requestId: string, usage?: { inputTokens: number; outputTokens: number }) {
  useModelActivity.getState().complete(requestId, usage);
}

export function failModelActivity(requestId: string, error: string) {
  useModelActivity.getState().fail(requestId, error);
}
