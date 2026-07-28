import { describe, expect, it } from "vitest";
import { normalizeFontSize } from "./fontSize";

describe("system font size", () => {
  it("defaults old and invalid settings to medium", () => {
    expect(normalizeFontSize(null)).toBe("medium");
    expect(normalizeFontSize("unexpected")).toBe("medium");
  });

  it("preserves explicit small and large choices", () => {
    expect(normalizeFontSize("small")).toBe("small");
    expect(normalizeFontSize("large")).toBe("large");
  });
});
