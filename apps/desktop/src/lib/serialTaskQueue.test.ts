import { describe, expect, it } from "vitest";
import { SerialTaskQueue } from "./serialTaskQueue";

describe("SerialTaskQueue", () => {
  it("keeps model role updates in request order", async () => {
    const queue = new SerialTaskQueue();
    const events: string[] = [];
    let releaseFirst: () => void = () => undefined;
    let markFirstStarted: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });

    const first = queue.run(async () => {
      events.push("clear-start");
      markFirstStarted();
      await firstGate;
      events.push("clear-finish");
    });
    const second = queue.run(async () => {
      events.push("configure");
    });

    await firstStarted;
    expect(events).toEqual(["clear-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["clear-start", "clear-finish", "configure"]);
  });

  it("continues after a failed synchronization", async () => {
    const queue = new SerialTaskQueue();
    await expect(queue.run(async () => { throw new Error("missing credential"); })).rejects.toThrow("missing credential");
    await expect(queue.run(async () => "configured")).resolves.toBe("configured");
  });
});
