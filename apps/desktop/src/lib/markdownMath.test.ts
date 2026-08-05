import { describe, expect, it } from "vitest";
import type { Root } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeKatex from "rehype-katex";
import { createDisplayMathPlugin, normalizeMarkdownMath } from "./markdownMath";

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

  it("promotes a single-line double-dollar equation to display math", async () => {
    const source = String.raw`$$\beta = 1 - \frac{d(z_i, c_i)}{\max_k d(z_k, c_k)} \tag{5}$$`;
    const processor = unified()
      .use(remarkParse)
      .use(remarkMath)
      .use(createDisplayMathPlugin(source));
    const tree = await processor.run(processor.parse(source)) as Root;

    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]).toMatchObject({
      type: "math",
      data: { hName: "pre" },
    });

    const renderedProcessor = unified()
      .use(remarkParse)
      .use(remarkMath)
      .use(createDisplayMathPlugin(source))
      .use(remarkRehype)
      .use(rehypeKatex);
    const rendered = await renderedProcessor.run(renderedProcessor.parse(source));
    const serialized = JSON.stringify(rendered);
    expect(serialized).toContain("katex-display");
    expect(serialized).not.toContain("katex-error");
  });

  it("leaves ordinary single-dollar inline math unchanged", async () => {
    const source = String.raw`$x_i$`;
    const processor = unified()
      .use(remarkParse)
      .use(remarkMath)
      .use(createDisplayMathPlugin(source));
    const tree = await processor.run(processor.parse(source)) as Root;

    expect(tree.children[0]).toMatchObject({ type: "paragraph" });
  });
});
