import { describe, expect, it } from "vitest";
import { prepareMarkdownForFormatting, restoreFormattedMarkdown, splitMarkdownForFormatting } from "./markdownFormatting";

describe("Markdown formatting evidence anchors", () => {
  it("round-trips internal anchors through model-safe placeholders", () => {
    const source = '<a data-paper-id="paper" data-page="2" data-block-id="intro-page-2-1"></a>\n\nText without useful line breaks.';
    const prepared = prepareMarkdownForFormatting(source);

    expect(prepared.promptText).toContain("[[P2I_EVIDENCE_ANCHOR_0]]");
    expect(restoreFormattedMarkdown(`\`\`\`markdown\n${prepared.promptText}\n\`\`\``, prepared.anchors)).toBe(source);
  });

  it("rejects model output that loses provenance", () => {
    const prepared = prepareMarkdownForFormatting('<a data-block-id="block-1"></a>\n\nText.');
    expect(() => restoreFormattedMarkdown("Text.", prepared.anchors)).toThrow(/removed evidence anchor/i);
  });

  it("splits long OCR text without dropping content", () => {
    const source = Array.from({ length: 800 }, (_, index) => `Sentence ${index}.`).join(" ");
    const chunks = splitMarkdownForFormatting(source, 2200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(" ")).toBe(source);
    expect(chunks.every((chunk) => chunk.length <= 2200)).toBe(true);
  });
});
