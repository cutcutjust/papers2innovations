import { describe, expect, it } from "vitest";
import { demoMarkdown, demoPapers } from "./demo";

describe("browser development fixture", () => {
  it("covers ready, processing, and failed states", () => {
    expect(new Set(demoPapers.map((paper) => paper.status))).toEqual(
      new Set(["READY", "PARSING_LAYOUT", "FAILED"]),
    );
  });

  it("includes Markdown features exercised by the reader", () => {
    expect(demoMarkdown).toContain("| Stage | Input | Persistent output |");
    expect(demoMarkdown).toContain("$$B_{safe}");
  });
});

