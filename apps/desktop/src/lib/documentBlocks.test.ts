import { describe, expect, it } from "vitest";
import { buildReaderBlocks, buildReaderSections, compactReaderBlocks, resolveMarkdownAssetPath, sanitizeExtractedMarkdown } from "./documentBlocks";

describe("structured Reader blocks", () => {
  it("removes internal provenance anchors without creating empty paragraphs", () => {
    const blocks = buildReaderBlocks(
      "page-1",
      '<a data-paper-id="paper" data-page="1" data-block-id="page-1-block-1"></a>\n\nActual paper text.',
      1,
    );

    expect(blocks).toEqual([{
      id: "page-1:block-1",
      sectionId: "page-1",
      text: "Actual paper text.",
      page: 1,
    }]);
  });

  it("keeps ordinary Markdown links and paragraph order", () => {
    const blocks = buildReaderBlocks("intro", "See [source](https://example.com).\n\nSecond paragraph.");
    expect(blocks.map((block) => block.text)).toEqual([
      "See [source](https://example.com).",
      "Second paragraph.",
    ]);
  });

  it("repairs PDF control glyphs and obvious wrapped words", () => {
    expect(sanitizeExtractedMarkdown("Linear\n\u0000\nGELU\n\u0001\nbi-\nases and cross-\nmodal")).toContain("Linear\n(\nGELU\n)\nbiases and cross-modal");
  });

  it("resolves relative Markdown figures beside the generated document", () => {
    expect(resolveMarkdownAssetPath("E:\\Library\\.p2i\\generated\\paper\\paper.md", "figures/figure-1.png"))
      .toBe("E:\\Library\\.p2i\\generated\\paper\\figures\\figure-1.png");
    expect(resolveMarkdownAssetPath("E:\\Library\\paper.md", "https://example.com/figure.png"))
      .toBe("https://example.com/figure.png");
  });

  it("compacts consecutive OCR labels without merging normal prose or figures", () => {
    const blocks = buildReaderBlocks("figure", [
      "Classifier", "Text-MoE", "Audio-MoE", "Vision-MoE", "Cross-attention", "Hub Token",
      "This is a normal explanatory paragraph that is intentionally long enough to remain independent from compact OCR labels in the Reader layout.",
      "![Architecture](figures/figure-1.png)",
    ].join("\n\n"));

    const compacted = compactReaderBlocks(blocks);

    expect(compacted).toHaveLength(3);
    expect(compacted[0].compacted).toBe(true);
    expect(compacted[0].text).toContain("Classifier; Text-MoE; Audio-MoE");
    expect(compacted[0].sourceBlockIds).toHaveLength(6);
    expect(compacted[1].compacted).not.toBe(true);
    expect(compacted[2].text).toContain("figure-1.png");
  });
});

describe("buildReaderSections", () => {
  it("groups legacy page artifacts into semantic paper sections", () => {
    const document = {
      schema_version: "1.0" as const,
      paper_id: "paper-1",
      source_sha256: "hash",
      title: "Paper",
      authors: [],
      page_count: 3,
      figures: [],
      tables: [],
      parser: { name: "pypdf", version: "1" },
      generated_at: "2026-01-01",
      sections: [
        { id: "section-1", title: "Page 1", level: 1, order: 0, page_start: 1, page_end: 1, markdown: "## Page 1\n\nAbstract\n\nSummary.", anchors: [] },
        { id: "section-2", title: "Page 2", level: 1, order: 1, page_start: 2, page_end: 2, markdown: "## Page 2\n\n1 Introduction\n\nOpening.", anchors: [] },
        { id: "section-3", title: "Page 3", level: 1, order: 2, page_start: 3, page_end: 3, markdown: "## Page 3\n\nContinued.\n\n2 Results\n\nEvidence.", anchors: [] },
      ],
    };

    const sections = buildReaderSections(document, "");

    expect(sections.map((section) => section.title)).toEqual(["Abstract", "1 Introduction", "2 Results"]);
    expect(sections[1].pageStart).toBe(2);
    expect(sections[1].pageEnd).toBe(3);
    expect(sections.every((section) => !/^Page /i.test(section.title))).toBe(true);
  });

  it("uses one Document section when legacy pages have no headings", () => {
    const document = {
      schema_version: "1.0" as const,
      paper_id: "paper-1",
      source_sha256: "hash",
      title: "Paper",
      authors: [],
      page_count: 2,
      figures: [],
      tables: [],
      parser: { name: "pypdf", version: "1" },
      generated_at: "2026-01-01",
      sections: [
        { id: "section-1", title: "Page 1", level: 1, order: 0, page_start: 1, page_end: 1, markdown: "Text one.", anchors: [] },
        { id: "section-2", title: "Page 2", level: 1, order: 1, page_start: 2, page_end: 2, markdown: "Text two.", anchors: [] },
      ],
    };

    const sections = buildReaderSections(document, "");

    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBe("Document");
    expect(sections[0].pageStart).toBe(1);
    expect(sections[0].pageEnd).toBe(2);
  });
});
