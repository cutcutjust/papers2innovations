import { describe, expect, it } from "vitest";
import { normalizeMarkdownMath } from "./markdownMath";

describe("AI Markdown math normalization", () => {
  it("converts model-style inline and display LaTeX delimiters", () => {
    const source = String.raw`The hub is \(\mathbf{X}_{\text{hub}}\).

\[ \mathbf{X}_{\text{hub}} = \frac{1}{3}[\mathbf{X}^{(t)} + \mathbf{X}^{(a)} + \mathbf{X}^{(v)}] \]`;

    expect(normalizeMarkdownMath(source)).toContain(String.raw`$ \mathbf{X}_{\text{hub}} $`);
    expect(normalizeMarkdownMath(source)).toContain(String.raw`$$ \mathbf{X}_{\text{hub}} = \frac{1}{3}[\mathbf{X}^{(t)} + \mathbf{X}^{(a)} + \mathbf{X}^{(v)}] $$`);
    expect(normalizeMarkdownMath(source)).toHaveLength(source.length);
  });

  it("does not rewrite LaTeX examples inside Markdown code", () => {
    const source = "Use \\(x\\) but keep `\\(inline\\)`.\n\n```latex\n\\[block_example\\]\n```";

    const normalized = normalizeMarkdownMath(source);
    expect(normalized).toContain('Use $ x $ but keep `\\(inline\\)`.');
    expect(normalized).toContain(String.raw`\[block_example\]`);
  });

  it("preserves already supported dollar delimiters", () => {
    const source = String.raw`Inline $x_i$ and display:

$$
\sum_i x_i
$$`;
    expect(normalizeMarkdownMath(source)).toBe(source);
  });
});
