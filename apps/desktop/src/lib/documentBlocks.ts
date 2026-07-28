import type { PaperDocument } from "@p2i/contracts";

export interface ReaderDocumentBlock {
  id: string;
  sectionId: string;
  text: string;
  page?: number;
}

export interface ReaderDisplaySection {
  id: string;
  title: string;
  level: number;
  pageStart?: number;
  pageEnd?: number;
  blocks: ReaderDocumentBlock[];
}

const INTERNAL_ANCHOR = /<a\b[^>]*\bdata-block-id=(?:"[^"]+"|'[^']+')[^>]*>\s*<\/a>/gi;
const WRAPPED_WORD = /\b([A-Za-z]{2,})-\r?\n([a-z]{2,})\b/g;
const PRESERVED_HYPHEN_LEFT = new Set([
  "cross", "feed", "high", "large", "low", "real", "self", "small", "spatio", "state", "task",
]);

export function sanitizeExtractedMarkdown(value: string): string {
  return value
    .replace(/[\u0000\u0010]/g, "(")
    .replace(/[\u0001\u0011]/g, ")")
    .replace(/[\u0002-\u0008\u000b\u000c\u000e\u000f\u0012-\u001f]/g, " ")
    .replace(WRAPPED_WORD, (_match, left: string, right: string) => (
      `${left}${PRESERVED_HYPHEN_LEFT.has(left.toLocaleLowerCase()) ? "-" : ""}${right}`
    ));
}

export function resolveMarkdownAssetPath(markdownPath: string | undefined, source: string | undefined): string | undefined {
  if (!source || /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/|\\|#)/.test(source) || !markdownPath) return source;
  const base = markdownPath.replace(/[\\/][^\\/]+$/, "");
  if (!base || base === markdownPath) return source;
  const separator = base.includes("\\") ? "\\" : "/";
  return `${base}${separator}${source.replace(/[\\/]/g, separator)}`;
}

export function buildReaderBlocks(sectionId: string, markdown: string, page?: number): ReaderDocumentBlock[] {
  return sanitizeExtractedMarkdown(markdown)
    .replace(INTERNAL_ANCHOR, "")
    .split(/\n{2,}/)
    .map((text) => text.trim())
    .filter((text) => text && !/^#{1,6}\s/.test(text))
    .map((text, index) => ({ id: `${sectionId}:block-${index + 1}`, sectionId, text, page }));
}

const KNOWN_SECTIONS = new Set([
  "abstract", "keywords", "key words", "introduction", "background", "related work",
  "literature review", "method", "methods", "methodology", "materials and methods",
  "approach", "model", "experiments", "experimental setup", "results", "discussion",
  "results and discussion", "limitations", "conclusion", "conclusions", "future work",
  "acknowledgements", "acknowledgments", "references", "bibliography", "appendix",
]);

function headingCandidate(line: string): { title: string; level: number } | undefined {
  const value = line.trim();
  if (!value || value.length > 120 || /^#{1,6}\s+page\s+\d+$/i.test(value)) return undefined;
  const markdown = value.match(/^(#{1,6})\s+(.+?)\s*$/);
  if (markdown) return { title: markdown[2].replace(/[*_`#]/g, "").trim(), level: Math.min(markdown[1].length, 3) };
  const title = value.replace(/[:.]$/, "").trim();
  if (KNOWN_SECTIONS.has(title.toLocaleLowerCase())) return { title, level: 1 };
  const numbered = title.match(/^((?:\d+(?:\.\d+)*|[IVXLC]+)[.)]?)\s+([A-Za-z].{1,100})$/i);
  if (!numbered || numbered[2].split(/\s+/).length > 12 || numbered[2].endsWith(".")) return undefined;
  return { title, level: Math.min((numbered[1].match(/\./g)?.length ?? 0) + 1, 3) };
}

function sectionId(title: string, used: Map<string, number>): string {
  const base = title.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "section";
  const count = (used.get(base) ?? 0) + 1;
  used.set(base, count);
  return count === 1 ? base : `${base}-${count}`;
}

export function buildReaderSections(document: PaperDocument | undefined, markdown: string): ReaderDisplaySection[] {
  if (!document?.sections.length) {
    return [{ id: "document", title: "Document", level: 1, blocks: buildReaderBlocks("document", markdown) }];
  }
  const ordered = [...document.sections].sort((left, right) => left.order - right.order);
  const legacyPages = ordered.every((section) => /^page\s+\d+$/i.test(section.title));
  if (!legacyPages) {
    return ordered.map((section) => ({
      id: section.id,
      title: section.title,
      level: section.level,
      pageStart: section.page_start,
      pageEnd: section.page_end,
      blocks: buildReaderBlocks(section.id, section.markdown, section.anchors[0]?.page ?? section.page_start),
    }));
  }

  type Draft = { title: string; level: number; pageStart: number; pageEnd: number; parts: string[] };
  const drafts: Draft[] = [];
  let current: Draft | undefined;
  let headingCount = 0;
  for (const source of ordered) {
    const page = source.page_start ?? source.anchors[0]?.page ?? source.order + 1;
    const cleaned = source.markdown.replace(INTERNAL_ANCHOR, "").replace(/^#{1,6}\s+Page\s+\d+\s*/i, "").trim();
    let pending: string[] = [];
    const append = () => {
      const body = pending.join("\n").trim();
      pending = [];
      if (!body) return;
      if (!current) {
        current = { title: "Overview", level: 1, pageStart: page, pageEnd: page, parts: [] };
        drafts.push(current);
      }
      current.pageEnd = page;
      current.parts.push(body);
    };
    for (const line of cleaned.split(/\r?\n/)) {
      const heading = headingCandidate(line);
      if (!heading) {
        pending.push(line);
        continue;
      }
      append();
      current = { title: heading.title, level: heading.level, pageStart: page, pageEnd: page, parts: [] };
      drafts.push(current);
      headingCount += 1;
    }
    append();
  }
  const populated = drafts.filter((draft) => draft.parts.length);
  const semantic = headingCount
    ? populated
    : [{
        title: "Document",
        level: 1,
        pageStart: populated[0]?.pageStart ?? 1,
        pageEnd: populated.at(-1)?.pageEnd ?? document.page_count,
        parts: populated.flatMap((draft) => draft.parts),
      }];
  const used = new Map<string, number>();
  return semantic.map((draft) => {
    const id = sectionId(draft.title, used);
    return {
      id,
      title: draft.title,
      level: draft.level,
      pageStart: draft.pageStart,
      pageEnd: draft.pageEnd,
      blocks: buildReaderBlocks(id, draft.parts.join("\n\n"), draft.pageStart),
    };
  });
}
