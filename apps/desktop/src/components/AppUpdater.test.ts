import { describe, expect, it } from "vitest";
import { shouldRunUpdateCheck, updatePercent } from "./AppUpdater";

describe("update progress", () => {
  it("reports bounded download percentages", () => {
    expect(updatePercent(25, 100)).toBe(25);
    expect(updatePercent(125, 100)).toBe(100);
  });

  it("supports servers without a content length", () => {
    expect(updatePercent(25, 0)).toBeUndefined();
  });

  it("throttles focus-triggered checks without blocking later reminders", () => {
    expect(shouldRunUpdateCheck(1_000, 4_000, 5_000)).toBe(false);
    expect(shouldRunUpdateCheck(1_000, 6_000, 5_000)).toBe(true);
  });
});
