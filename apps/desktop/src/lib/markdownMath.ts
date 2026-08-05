import type { Root, RootContent } from "mdast";
import type { Plugin } from "unified";

const FENCED_CODE = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\r?\n|$)[\s\S]*?^ {0,3}\1[ \t]*(?=\r?$)/gm;
const INLINE_CODE = /(`+)([^`\n]*?)\1/g;

function normalizeTextMath(value: string): string {
  return value
    // Keep replacement lengths stable so Reader source offsets remain valid.
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, expression: string) => `$$${expression}$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, expression: string) => `$ ${expression} $`);
}

function normalizeInlineCodeAware(value: string): string {
  let output = "";
  let cursor = 0;
  for (const match of value.matchAll(INLINE_CODE)) {
    const index = match.index ?? 0;
    output += normalizeTextMath(value.slice(cursor, index));
    output += match[0];
    cursor = index + match[0].length;
  }
  return output + normalizeTextMath(value.slice(cursor));
}

export function normalizeMarkdownMath(value: string): string {
  let output = "";
  let cursor = 0;
  for (const match of value.matchAll(FENCED_CODE)) {
    const index = match.index ?? 0;
    output += normalizeInlineCodeAware(value.slice(cursor, index));
    output += match[0];
    cursor = index + match[0].length;
  }
  return output + normalizeInlineCodeAware(value.slice(cursor));
}

/** Promote a paragraph containing one single-line $$...$$ node to display math. */
export function createDisplayMathPlugin(source: string): Plugin<[], Root> {
  return function displayMathPlugin() {
    return (tree: Root) => {
      tree.children = tree.children.map((node): RootContent => {
        if (node.type !== "paragraph" || node.children?.length !== 1) return node;
        const inline = node.children[0];
        if (inline.type !== "inlineMath") return node;
        const start = node.position?.start?.offset;
        const end = node.position?.end?.offset;
        if (!Number.isInteger(start) || !Number.isInteger(end)) return node;
        const original = source.slice(start, end).trim();
        if (!/^\$\$[\s\S]*\$\$$/.test(original)) return node;
        const value = inline.value ?? "";
        return {
          type: "math",
          value,
          position: node.position,
          data: {
            hName: "pre",
            hChildren: [{
              type: "element",
              tagName: "code",
              properties: { className: ["language-math", "math-display"] },
              children: [{ type: "text", value }],
            }],
          },
        } as RootContent;
      });
    };
  };
}
