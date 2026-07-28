const INTERNAL_ANCHOR = /<a\b[^>]*\bdata-block-id=(?:"[^"]+"|'[^']+')[^>]*>\s*<\/a>/gi;
const TOKEN_PREFIX = "P2I_EVIDENCE_ANCHOR_";

export const MARKDOWN_FORMAT_PROMPT_VERSION = "markdown-format-v1";

export interface PreparedMarkdown {
  promptText: string;
  anchors: string[];
}

export function prepareMarkdownForFormatting(markdown: string): PreparedMarkdown {
  const anchors: string[] = [];
  const promptText = markdown.replace(INTERNAL_ANCHOR, (anchor) => {
    const index = anchors.push(anchor) - 1;
    return `[[${TOKEN_PREFIX}${index}]]`;
  });
  return { promptText, anchors };
}

export function restoreFormattedMarkdown(output: string, anchors: string[]): string {
  let markdown = output.trim();
  const fenced = markdown.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  if (fenced) markdown = fenced[1].trim();
  anchors.forEach((anchor, index) => {
    const token = `[[${TOKEN_PREFIX}${index}]]`;
    if (!markdown.includes(token)) throw new Error(`Formatting model removed evidence anchor ${index + 1}.`);
    markdown = markdown.replaceAll(token, anchor);
  });
  if (markdown.includes(`[[${TOKEN_PREFIX}`)) throw new Error("Formatting model returned an unknown evidence anchor.");
  if (!markdown.trim()) throw new Error("Formatting model returned empty Markdown.");
  return markdown.trim();
}

export function splitMarkdownForFormatting(markdown: string, maxCharacters: number): string[] {
  const limit = Math.max(2000, maxCharacters);
  const chunks: string[] = [];
  let remaining = markdown.trim();
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    const candidates = [window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(". "), window.lastIndexOf("; "), window.lastIndexOf(" ")];
    const best = Math.max(...candidates);
    const cut = best >= Math.floor(limit * 0.55) ? best + 1 : limit;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
