import { describe, expect, it } from "vitest";
import { buildReaderBlocks, buildReaderSections } from "./documentBlocks";

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
