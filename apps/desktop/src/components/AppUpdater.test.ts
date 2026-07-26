import { describe, expect, it } from "vitest";
import { updatePercent } from "./AppUpdater";

describe("update progress", () => {
  it("reports bounded download percentages", () => {
    expect(updatePercent(25, 100)).toBe(25);
    expect(updatePercent(125, 100)).toBe(100);
  });

  it("supports servers without a content length", () => {
    expect(updatePercent(25, 0)).toBeUndefined();
  });
});
