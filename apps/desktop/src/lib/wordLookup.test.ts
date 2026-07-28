import { describe, expect, it } from "vitest";
import { buildWordLookupMessages, isSingleEnglishWord } from "./wordLookup";

describe("paper-aware word lookup", () => {
  it("distinguishes a word from a phrase or formula", () => {
    expect(isSingleEnglishWord("heterogeneous")).toBe(true);
    expect(isSingleEnglishWord("paper's")).toBe(true);
    expect(isSingleEnglishWord("cross-modal")).toBe(true);
    expect(isSingleEnglishWord("cross modal")).toBe(false);
    expect(isSingleEnglishWord("x=1")).toBe(false);
  });

  it("includes paper-wide and local context in the prompt", () => {
    const messages = buildWordLookupMessages("alignment", {
      paperTitle: "A Multimodal Study",
      sectionTitle: "Method",
      outline: ["Abstract", "Method", "Results"],
      selectedParagraph: "We optimize alignment between modalities.",
      adjacentText: "The encoders share a latent space.",
      paperExcerpt: "This paper studies robust multimodal learning.",
    });
    expect(messages[1].content).toContain("A Multimodal Study");
    expect(messages[1].content).toContain("Results");
    expect(messages[1].content).toContain("optimize alignment");
  });
});
