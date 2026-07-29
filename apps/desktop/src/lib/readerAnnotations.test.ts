import { describe, expect, it } from "vitest";
import type { ReaderAnnotation } from "@p2i/contracts";
import { createReaderAnnotationPlugin } from "./readerAnnotations";

describe("reader annotation renderer", () => {
  it("splits source text into independently addressable translation and chat runs", () => {
    const source = "First result. Second result.";
    const annotation: ReaderAnnotation = {
      id: "chat-annotation", paperId: "paper", sectionId: "intro", blockId: "block",
      sourceHash: "paper-hash", sourceStart: 6, sourceEnd: 12, annotationType: "chat",
      targetType: "chat_turn", relatedId: "turn", selectedText: "result", anchorHash: "anchor",
      createdAt: "now", updatedAt: "now",
    };
    const tree = {
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "text", value: source, position: { start: { offset: 0 }, end: { offset: source.length } } }] }],
    };
    const transform = createReaderAnnotationPlugin({
      source,
      view: "original",
      translations: [{ recordId: "translation", segmentId: "sentence-1", sourceStart: 0, sourceEnd: 13, sourceText: "First result.", translatedText: "第一个结果。", terms: [] }],
      annotations: [annotation],
    })();
    transform(tree);
    const runs = tree.children[0].children as Array<{ data?: { hProperties?: Record<string, string> } }>;
    expect(runs.length).toBeGreaterThan(2);
    expect(runs.some((run) => run.data?.hProperties?.["data-translation-id"] === "translation")).toBe(true);
    expect(runs.some((run) => run.data?.hProperties?.["data-chat-annotation-ids"] === "chat-annotation")).toBe(true);
  });

  it("keeps a translated sentence whole when a chat range overlaps it", () => {
    const source = "First result.";
    const annotation = {
      id: "chat", paperId: "paper", sectionId: "intro", blockId: "block", sourceHash: "hash",
      sourceStart: 6, sourceEnd: 12, annotationType: "chat" as const, targetType: "chat_turn" as const,
      relatedId: "turn", selectedText: "result", anchorHash: "anchor", createdAt: "now", updatedAt: "now",
    };
    const tree = { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: source, position: { start: { offset: 0 }, end: { offset: source.length } } }] }] };
    createReaderAnnotationPlugin({ source, view: "translated", translations: [{ recordId: "translation", segmentId: "sentence-1", sourceStart: 0, sourceEnd: source.length, sourceText: source, translatedText: "第一个结果。", terms: [] }], annotations: [annotation] })()(tree);
    const runs = tree.children[0].children as Array<{ children?: Array<{ value?: string }> }>;
    expect(runs).toHaveLength(1);
    expect(runs[0].children?.[0].value).toBe("第一个结果。");
  });
});
