import { describe, expect, it } from "vitest";
import { contrastRatio, isDisplayableTranslationTerm, parseStructuredTranslation, splitTranslationSegments, translationTermParts } from "./readerTranslation";

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

  it("highlights the same professional term in source and translated text", () => {
    const term = {
      text: "graph neural network", translation: "图神经网络", explanation: "图结构深度学习模型", kind: "term" as const,
      sourceStart: 4, sourceEnd: 24, translatedStart: 2, translatedEnd: 7, specialtyScore: 0.94,
      category: "model" as const,
    };
    expect(translationTermParts("A graph neural network model", [term], "source", 2).find((part) => part.term)?.text).toBe("graph neural network");
    expect(translationTermParts("该图神经网络模型", [term], "translated").find((part) => part.term)?.text).toBe("图神经网络");
  });

  it("hides ordinary academic wording and keeps domain-specific concepts", () => {
    expect(isDisplayableTranslationTerm({ text: "significant challenges", translation: "重大挑战", explanation: "常规表达", kind: "phrase", specialtyScore: 0.31 })).toBe(false);
    expect(isDisplayableTranslationTerm({ text: "multimodal emotion recognition", translation: "多模态情感识别", explanation: "融合多种模态识别情感的研究任务", kind: "term", category: "domain_term", specialtyScore: 0.93 })).toBe(true);
    expect(isDisplayableTranslationTerm({ text: "practical applications", translation: "实际应用", explanation: "常规表达", kind: "phrase" })).toBe(false);
  });

  it("parses specialty metadata from structured translation output", () => {
    const source = "We use SH-MHMoE for fusion.";
    const parsed = parseStructuredTranslation(source, JSON.stringify({
      segments: [{ id: "sentence-1", translatedText: "我们使用 SH-MHMoE 进行融合。" }],
      terms: [{ text: "SH-MHMoE", translation: "SH-MHMoE", kind: "term", segmentId: "sentence-1", sourceStart: 7, sourceEnd: 15, translatedStart: 5, translatedEnd: 13, category: "model", domain: "多模态情感识别", specialtyScore: 0.98, selectionReason: "论文提出的专有模型" }],
    }));
    expect(parsed.terms[0].category).toBe("model");
    expect(parsed.terms[0].specialtyScore).toBe(0.98);
    expect(parsed.terms[0].selectionReason).toContain("专有模型");
  });
});
