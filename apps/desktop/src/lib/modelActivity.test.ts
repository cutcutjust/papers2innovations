import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useModelActivity } from "./modelActivity";

describe("model activity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useModelActivity.setState({ activities: {} });
  });
  afterEach(() => vi.useRealTimers());

  it("distinguishes request start, connection, first token, and completion", () => {
    const store = useModelActivity.getState();
    store.begin("request", { source: "translation", label: "翻译论文文本", modelName: "Test Model" });
    store.applyStreamEvent({ requestId: "request", kind: "started" });
    expect(useModelActivity.getState().activities.request.phase).toBe("sending");
    store.applyStreamEvent({ requestId: "request", kind: "connected" });
    expect(useModelActivity.getState().activities.request.connectedAt).toBeTypeOf("number");
    store.applyStreamEvent({ requestId: "request", kind: "thinking", reasoningCharacters: 24 });
    expect(useModelActivity.getState().activities.request.phase).toBe("thinking");
    expect(useModelActivity.getState().activities.request.reasoningCharacters).toBe(24);
    store.applyStreamEvent({ requestId: "request", kind: "delta", text: "response" });
    expect(useModelActivity.getState().activities.request.phase).toBe("streaming");
    expect(useModelActivity.getState().activities.request.receivedCharacters).toBe(8);
    store.applyStreamEvent({ requestId: "request", kind: "done", usage: { inputTokens: 10, outputTokens: 3 } });
    expect(useModelActivity.getState().activities.request.phase).toBe("completed");
    expect(useModelActivity.getState().activities.request.usage?.outputTokens).toBe(3);
  });

  it("does not report a failed request as successful", () => {
    const store = useModelActivity.getState();
    store.begin("failed", { source: "reader-chat", label: "论文问答", modelName: "Test Model" });
    store.applyStreamEvent({ requestId: "failed", kind: "started" });
    store.applyStreamEvent({ requestId: "failed", kind: "error", error: "HTTP 401" });
    expect(useModelActivity.getState().activities.failed.phase).toBe("error");
    expect(useModelActivity.getState().activities.failed.connectedAt).toBeUndefined();
    expect(useModelActivity.getState().activities.failed.error).toBe("HTTP 401");
  });
});
