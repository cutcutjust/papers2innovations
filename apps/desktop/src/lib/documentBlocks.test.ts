import { describe, expect, it } from "vitest";
import { buildReaderBlocks } from "./documentBlocks";

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
