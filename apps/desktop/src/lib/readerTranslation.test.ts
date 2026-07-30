import { describe, expect, it } from "vitest";
import { contrastRatio, parseStructuredTranslation, splitTranslationSegments } from "./readerTranslation";

describe("reader translation", () => {
  it("keeps formulas and Markdown images inside sentence anchors", () => {
    const source = "We define $x = 1$. Figure follows ![plot](figures/a.png). Next result.";
    const segments = splitTranslationSegments(source);
    expect(segments.length).toBeGreaterThan(3);
    expect(segments.every((segment) => !segment.sourceText.includes("$x = 1$") && !segment.sourceText.includes("![plot]"))).toBe(true);
    expect(segments.map((segment) => segment.sourceText).join(" ")).toContain("Next result.");
  });

  it("parses aligned translations and falls back for plain text", () => {
    const source = "First result. Second result.";
    const parsed = parseStructuredTranslation(source, JSON.stringify({
      segments: [{ id: "sentence-1", translatedText: "第一个结果。" }, { id: "sentence-2", translatedText: "第二个结果。" }],
      terms: [{ text: "result", translation: "结果", explanation: "实验结果", kind: "term", segmentId: "sentence-1" }],
    }));
    expect(parsed.segments[0].translatedText).toBe("第一个结果。");
    expect(parsed.terms[0].kind).toBe("term");
    expect(parsed.terms[0].contextMeaning).toBe("实验结果");
    expect(parsed.terms[0].sourceStart).toBe(6);
    expect(parseStructuredTranslation(source, "直接译文").translatedText).toBe("直接译文");
  });

  it("checks custom reading color contrast", () => {
    expect(contrastRatio("#ffffff", "#111111")).toBeGreaterThan(7);
  });

  it("validates translated term offsets and falls back to a unique translated phrase", () => {
    const source = "Graph neural network improves results.";
    const parsed = parseStructuredTranslation(source, JSON.stringify({
      segments: [{ id: "sentence-1", translatedText: "图神经网络改善了结果。" }],
      terms: [{ text: "Graph neural network", translation: "图神经网络", kind: "term", segmentId: "sentence-1", translatedStart: 99, translatedEnd: 100 }],
    }));
    expect(parsed.terms[0].translatedStart).toBe(0);
    expect(parsed.terms[0].translatedEnd).toBe(5);
  });
});
