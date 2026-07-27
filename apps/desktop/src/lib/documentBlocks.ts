export interface ReaderDocumentBlock {
  id: string;
  sectionId: string;
  text: string;
  page?: number;
}

const INTERNAL_ANCHOR = /<a\b[^>]*\bdata-block-id=(?:"[^"]+"|'[^']+')[^>]*>\s*<\/a>/gi;

export function buildReaderBlocks(sectionId: string, markdown: string, page?: number): ReaderDocumentBlock[] {
  return markdown
    .replace(INTERNAL_ANCHOR, "")
    .split(/\n{2,}/)
    .map((text) => text.trim())
    .filter((text) => text && !/^#{1,6}\s/.test(text))
    .map((text, index) => ({ id: `${sectionId}:block-${index + 1}`, sectionId, text, page }));
}
