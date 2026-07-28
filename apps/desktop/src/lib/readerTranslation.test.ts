import { describe, expect, it } from "vitest";
import { contrastRatio, parseStructuredTranslation, splitTranslationSegments } from "./readerTranslation";

describe("reader translation", () => {
  it("keeps formulas and Markdown images inside sentence anchors", () => {
    const source = "We define $x = 1$. Figure follows ![plot](figures/a.png). Next result.";
    const segments = splitTranslationSegments(source);
    expect(segments).toHaveLength(3);
    expect(segments[0].sourceText).toContain("$x = 1$");
    expect(segments[1].sourceText).toContain("![plot](figures/a.png)");
  });

  it("parses aligned translations and falls back for plain text", () => {
    const source = "First result. Second result.";
    const parsed = parseStructuredTranslation(source, JSON.stringify({
      segments: [{ id: "sentence-1", translatedText: "第一个结果。" }, { id: "sentence-2", translatedText: "第二个结果。" }],
      terms: [{ text: "result", translation: "结果", explanation: "实验结果", kind: "term", segmentId: "sentence-1" }],
    }));
    expect(parsed.segments[0].translatedText).toBe("第一个结果。");
    expect(parsed.terms[0].kind).toBe("term");
    expect(parseStructuredTranslation(source, "直接译文").translatedText).toBe("直接译文");
  });

  it("checks custom reading color contrast", () => {
    expect(contrastRatio("#ffffff", "#111111")).toBeGreaterThan(7);
  });
});
