import { describe, expect, it } from "vitest";
import { contextCompressionBudgetError, contextCompressionMessages } from "./contextCompression";

describe("Context compression", () => {
  it("keeps source provenance in the model request", () => {
    const messages = contextCompressionMessages({
      id: "item-1",
      paperId: "paper-1",
      paperTitle: "Grounded Paper",
      sourceHash: "sha256-source",
      sourceText: "Evidence paragraph.",
      estimatedTokens: 5,
    });

    expect(messages[1].content).toContain("Grounded Paper");
    expect(messages[1].content).toContain("sha256-source");
    expect(messages[1].content).toContain("Evidence paragraph.");
  });

  it("rejects sources that would consume the output and safety reserve", () => {
    expect(contextCompressionBudgetError(1000, 128000, 4096)).toBeUndefined();
    const error = contextCompressionBudgetError(120000, 128000, 4096);
    expect(error).toContain("更长上下文的模型");
    expect(error).toContain("120,000");
  });
});
