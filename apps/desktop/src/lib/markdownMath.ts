const FENCED_CODE = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\r?\n|$)[\s\S]*?^ {0,3}\1[ \t]*(?=\r?$)/gm;
const INLINE_CODE = /(`+)([^`\n]*?)\1/g;

function normalizeTextMath(value: string): string {
  return value
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, expression: string) => `\n\n$$\n${expression.trim()}\n$$\n\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, expression: string) => `$${expression.trim()}$`);
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
