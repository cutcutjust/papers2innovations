import type { TranslationSegment, TranslationTerm } from "@p2i/contracts";

export interface StructuredTranslation {
  translatedText: string;
  segments: TranslationSegment[];
  terms: TranslationTerm[];
  structured: boolean;
  missingSegmentIds: string[];
  error?: string;
}

export type TranslationAnchorStatus = "exact" | "whitespace-remapped" | "stale";

export interface TranslationAnchorProjection {
  segmentId: string;
  sourceStart: number;
  sourceEnd: number;
  status: TranslationAnchorStatus;
}

export interface TranslationBlockSource {
  id: string;
  text: string;
}

export interface TranslationBlockProjection extends TranslationAnchorProjection {
  blockId?: string;
}

export interface TranslationTermPart {
  text: string;
  term?: TranslationTerm;
}

const SPECIALTY_THRESHOLD = 0.72;
const COMMON_ACADEMIC_WORDS = new Set([
  "achieve", "analysis", "application", "approach", "challenge", "different", "effective", "existing", "important", "improve", "method", "model", "performance", "practical", "problem", "result", "significant", "system", "task", "use", "using",
]);

export function isDisplayableTranslationTerm(term: TranslationTerm): boolean {
  if (typeof term.specialtyScore === "number") return term.specialtyScore >= SPECIALTY_THRESHOLD;
  const normalized = term.text.trim();
  if (!normalized) return false;
  if (term.category || /^[A-Z][A-Z0-9-]{1,}$/.test(normalized) || /[A-Z].*[A-Z]|\d/.test(normalized)) return true;
  const words = normalized.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length < 2 || words.every((word) => COMMON_ACADEMIC_WORDS.has(word))) return false;
  const context = (term.contextMeaning || term.explanation || "").trim();
  return context.length >= 12 && words.some((word) => !COMMON_ACADEMIC_WORDS.has(word));
}

export function translationTermParts(text: string, terms: TranslationTerm[], language: "source" | "translated", sourceBase = 0): TranslationTermPart[] {
  const ranges = terms.filter(isDisplayableTranslationTerm).flatMap((term) => {
    const expected = language === "source" ? term.text : term.translation;
    const proposedStart = Number(language === "source" ? term.sourceStart : term.translatedStart);
    const proposedEnd = Number(language === "source" ? term.sourceEnd : term.translatedEnd);
    const start = language === "source" ? proposedStart - sourceBase : proposedStart;
    const end = language === "source" ? proposedEnd - sourceBase : proposedEnd;
    if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= text.length && text.slice(start, end) === expected) return [{ start, end, term }];
    const needle = expected.trim();
    if (!needle) return [];
    const found = text.indexOf(needle);
    return found >= 0 && text.indexOf(needle, found + needle.length) < 0 ? [{ start: found, end: found + needle.length, term }] : [];
  }).sort((left, right) => left.start - right.start || left.end - right.end);
  const parts: TranslationTermPart[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    if (range.start > cursor) parts.push({ text: text.slice(cursor, range.start) });
    parts.push({ text: text.slice(range.start, range.end), term: range.term });
    cursor = range.end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts.length ? parts : [{ text }];
}

const PROTECTED_MARKDOWN = /(!\[[^\]]*\]\([^)]*\)|\$\$[\s\S]*?\$\$|\$[^$\n]+\$|\\\[[\s\S]*?\\\]|`[^`]+`|\[[^\]]+\]\([^)]*\))/g;

export function protectedMarkdownRanges(source: string): Array<[number, number]> {
  return [...source.matchAll(PROTECTED_MARKDOWN)].map((match) => {
    const start = match.index ?? 0;
    return [start, start + match[0].length];
  });
}

export function splitTranslationSegments(source: string): TranslationSegment[] {
  const protectedRanges = protectedMarkdownRanges(source);
  const insideProtected = (index: number) => protectedRanges.some(([start, end]) => index >= start && index < end);
  const boundaries = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (insideProtected(index)) continue;
    const character = source[index];
    const next = source[index + 1] ?? "";
    if (/[.!?。！？]/.test(character) && (next === "" || /\s/.test(next))) {
      boundaries.push(index + 1);
    }
  }
  if (boundaries.at(-1) !== source.length) boundaries.push(source.length);
  const rawSegments = boundaries.slice(0, -1).flatMap((start, index) => {
    const end = boundaries[index + 1];
    const cuts = [start, end, ...protectedRanges.flatMap(([protectedStart, protectedEnd]) => (
      protectedEnd <= start || protectedStart >= end ? [] : [Math.max(start, protectedStart), Math.min(end, protectedEnd)]
    ))].sort((left, right) => left - right);
    return cuts.slice(0, -1).flatMap((partStart, partIndex) => {
      const partEnd = cuts[partIndex + 1];
      const protectedPart = protectedRanges.some(([protectedStart, protectedEnd]) => partStart >= protectedStart && partEnd <= protectedEnd);
      return protectedPart ? [] : [{ sourceStart: partStart, sourceEnd: partEnd }];
    });
  }).map(({ sourceStart, sourceEnd }) => {
    while (sourceStart < sourceEnd && /\s/.test(source[sourceStart])) sourceStart += 1;
    while (sourceEnd > sourceStart && /\s/.test(source[sourceEnd - 1])) sourceEnd -= 1;
    return { sourceStart, sourceEnd };
  }).filter(({ sourceStart, sourceEnd }) => sourceEnd > sourceStart);
  return rawSegments.map(({ sourceStart, sourceEnd }, index) => ({
    id: `sentence-${index + 1}`,
    sourceStart,
    sourceEnd,
    sourceText: source.slice(sourceStart, sourceEnd),
    translatedText: "",
  }));
}

export function splitTranslationChunks(source: string, maxCharacters = 1200, maxSentences = 4): Array<{ start: number; end: number; text: string }> {
  const segments = splitTranslationSegments(source);
  if (!segments.length) return source.trim() ? [{ start: 0, end: source.length, text: source }] : [];
  const chunks: Array<{ start: number; end: number; text: string }> = [];
  let start = segments[0].sourceStart;
  let end = segments[0].sourceEnd;
  let sentenceCount = 1;
  for (const segment of segments.slice(1)) {
    if (segment.sourceEnd - start > maxCharacters || sentenceCount >= maxSentences) {
      chunks.push({ start, end, text: source.slice(start, end) });
      start = segment.sourceStart;
      sentenceCount = 0;
    }
    end = segment.sourceEnd;
    sentenceCount += 1;
  }
  chunks.push({ start, end, text: source.slice(start, end) });
  return chunks;
}

function normalizedWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizedTextMap(value: string): { text: string; starts: number[]; ends: number[] } {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (let index = 0; index < value.length;) {
    if (/\s/.test(value[index])) {
      const start = index;
      while (index < value.length && /\s/.test(value[index])) index += 1;
      if (text && !text.endsWith(" ") && index < value.length) {
        text += " ";
        starts.push(start);
        ends.push(index);
      }
      continue;
    }
    text += value[index];
    starts.push(index);
    ends.push(index + 1);
    index += 1;
  }
  return { text, starts, ends };
}

function trimmedRange(source: string, start: number, end: number): { start: number; end: number } {
  let nextStart = Math.max(0, start);
  let nextEnd = Math.min(source.length, end);
  while (nextStart < nextEnd && /\s/.test(source[nextStart])) nextStart += 1;
  while (nextEnd > nextStart && /\s/.test(source[nextEnd - 1])) nextEnd -= 1;
  return { start: nextStart, end: nextEnd };
}

function normalizedBoundaryIndex(value: string, offset: number): number {
  let normalizedLength = 0;
  let hasText = false;
  for (let index = 0; index < Math.min(offset, value.length);) {
    if (/\s/.test(value[index])) {
      let end = index;
      while (end < value.length && /\s/.test(value[end])) end += 1;
      if (hasText && end <= offset && end < value.length) normalizedLength += 1;
      index = Math.min(end, offset);
      continue;
    }
    hasText = true;
    normalizedLength += 1;
    index += 1;
  }
  return normalizedLength;
}

export function projectTranslationSegments(recordSource: string, currentSource: string, segments: TranslationSegment[]): TranslationAnchorProjection[] {
  const exact = recordSource === currentSource;
  const recordMap = normalizedTextMap(recordSource);
  const currentMap = normalizedTextMap(currentSource);
  const whitespaceEquivalent = !exact && recordMap.text === currentMap.text;
  let fallbackCursor = 0;

  return segments.map((segment) => {
    const range = trimmedRange(recordSource, segment.sourceStart, segment.sourceEnd);
    const exactText = recordSource.slice(range.start, range.end);
    if (!exactText) return { segmentId: segment.id, sourceStart: 0, sourceEnd: 0, status: "stale" };
    if (exact && currentSource.slice(range.start, range.end) === exactText) {
      return { segmentId: segment.id, sourceStart: range.start, sourceEnd: range.end, status: "exact" };
    }

    if (whitespaceEquivalent) {
      const normalizedStart = normalizedBoundaryIndex(recordSource, range.start);
      const normalizedEnd = normalizedBoundaryIndex(recordSource, range.end);
      const sourceStart = currentMap.starts[normalizedStart];
      const sourceEnd = currentMap.ends[normalizedEnd - 1];
      if (sourceStart !== undefined && sourceEnd !== undefined && normalizedWhitespace(currentSource.slice(sourceStart, sourceEnd)) === normalizedWhitespace(exactText)) {
        return { segmentId: segment.id, sourceStart, sourceEnd, status: "whitespace-remapped" };
      }
    }

    const needle = normalizedWhitespace(exactText);
    const found = needle ? currentMap.text.indexOf(needle, fallbackCursor) : -1;
    const repeated = found >= 0 && currentMap.text.indexOf(needle, found + needle.length) >= 0;
    if (found >= 0 && !repeated) {
      fallbackCursor = found + needle.length;
      const sourceStart = currentMap.starts[found];
      const sourceEnd = currentMap.ends[found + needle.length - 1];
      if (sourceStart !== undefined && sourceEnd !== undefined) {
        return { segmentId: segment.id, sourceStart, sourceEnd, status: "whitespace-remapped" };
      }
    }
    return { segmentId: segment.id, sourceStart: 0, sourceEnd: 0, status: "stale" };
  });
}

export function projectTranslationSegmentsAcrossBlocks(
  recordSource: string,
  blocks: TranslationBlockSource[],
  segments: TranslationSegment[],
): TranslationBlockProjection[] {
  const ranges: Array<{ blockId: string; start: number; end: number }> = [];
  let currentSource = "";
  for (const block of blocks) {
    if (currentSource) currentSource += "\n\n";
    const start = currentSource.length;
    currentSource += block.text;
    ranges.push({ blockId: block.id, start, end: currentSource.length });
  }
  return projectTranslationSegments(recordSource, currentSource, segments).map((projection) => {
    if (projection.status === "stale") return projection;
    const block = ranges.find((candidate) => projection.sourceStart >= candidate.start && projection.sourceEnd <= candidate.end);
    if (!block) return { ...projection, sourceStart: 0, sourceEnd: 0, status: "stale" };
    return {
      ...projection,
      blockId: block.blockId,
      sourceStart: projection.sourceStart - block.start,
      sourceEnd: projection.sourceEnd - block.start,
    };
  });
}

export function structuredTranslationPrompt(source: string): string {
  const segments = splitTranslationSegments(source);
  return [
    "请按句翻译下面的学术文本。公式、引用、数字、Markdown 链接和图片标记必须原样保留。",
    "只返回 JSON，不要使用 Markdown 代码围栏。格式：",
    '{"segments":[{"id":"sentence-1","translatedText":"..."}],"terms":[{"text":"...","translation":"...","sourceStart":0,"sourceEnd":8,"translatedStart":0,"translatedEnd":4,"literalMeaning":"...","contextMeaning":"...","explanation":"...","kind":"phrase|term","category":"domain_term|method|model|dataset|acronym|technical_phrase","domain":"...","specialtyScore":0.0,"selectionReason":"...","segmentId":"sentence-1"}]}',
    "translatedStart/translatedEnd 使用对应 translatedText 内的字符偏移，必须准确覆盖术语的中文译法。",
    "segments 必须逐一返回且 id 不得改变；sourceStart/sourceEnd 使用给定原文的绝对字符偏移。",
    "terms 采用严格专业模式：只收录论文领域术语、方法或模型名、数据集、缩写、专有模块，以及在本文语境中具有特殊含义的技术固定概念。普通日常词、普通学术动词或形容词、泛化表达（例如 significant challenges、practical applications、existing methods、results）不得收录。没有合格术语时返回空数组。",
    "specialtyScore 表示专业专属性，范围 0 到 1；只有不低于 0.72 的项目才应返回，并用 selectionReason 简短说明其专业性。",
    JSON.stringify({ segments: segments.map(({ id, sourceStart, sourceEnd, sourceText }) => ({ id, sourceStart, sourceEnd, sourceText })) }),
  ].join("\n\n");
}

function stripFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

export function parseStructuredTranslation(source: string, response: string): StructuredTranslation {
  const sourceSegments = splitTranslationSegments(source);
  try {
    const parsed = JSON.parse(stripFence(response)) as { segments?: Array<{ id?: string; translatedText?: string }>; terms?: TranslationTerm[] };
    const values = new Map((parsed.segments ?? []).map((segment) => [segment.id, String(segment.translatedText ?? "").trim()]));
    const missingSegmentIds = sourceSegments.filter((segment) => !values.get(segment.id)?.trim()).map((segment) => segment.id);
    const segments = sourceSegments
      .filter((segment) => Boolean(values.get(segment.id)?.trim()))
      .map((segment) => ({ ...segment, translatedText: values.get(segment.id)! }));
    const terms = (parsed.terms ?? []).filter((term) => term && term.text && term.translation).map((term) => {
      const text = String(term.text);
      const segment = sourceSegments.find((candidate) => candidate.id === term.segmentId);
      const located = segment ? segment.sourceText.indexOf(text) : -1;
      const proposedStart = Number(term.sourceStart);
      const sourceStart = Number.isInteger(proposedStart) && proposedStart >= 0 && source.slice(proposedStart, proposedStart + text.length) === text
        ? proposedStart
        : located >= 0 && segment ? segment.sourceStart + located : undefined;
      const proposedEnd = Number(term.sourceEnd);
      const sourceEnd = sourceStart === undefined ? undefined : (
        Number.isInteger(proposedEnd) && proposedEnd >= sourceStart && proposedEnd <= source.length ? proposedEnd : sourceStart + text.length
      );
      const translation = String(term.translation);
      const translatedSegment = segments.find((candidate) => candidate.id === term.segmentId)?.translatedText ?? "";
      const proposedTranslatedStart = Number(term.translatedStart);
      const proposedTranslatedEnd = Number(term.translatedEnd);
      const validTranslatedRange = Number.isInteger(proposedTranslatedStart)
        && Number.isInteger(proposedTranslatedEnd)
        && proposedTranslatedStart >= 0
        && proposedTranslatedEnd > proposedTranslatedStart
        && proposedTranslatedEnd <= translatedSegment.length
        && translatedSegment.slice(proposedTranslatedStart, proposedTranslatedEnd) === translation;
      const locatedTranslation = translatedSegment.indexOf(translation);
      const uniqueTranslation = locatedTranslation >= 0 && translatedSegment.indexOf(translation, locatedTranslation + translation.length) < 0;
      return {
        text,
        translation,
        explanation: String(term.explanation ?? ""),
        kind: term.kind === "phrase" ? "phrase" as const : "term" as const,
        segmentId: term.segmentId ? String(term.segmentId) : undefined,
        sourceStart,
        sourceEnd,
        literalMeaning: String(term.literalMeaning ?? term.translation ?? ""),
        contextMeaning: String(term.contextMeaning ?? term.explanation ?? ""),
        translatedStart: validTranslatedRange ? proposedTranslatedStart : uniqueTranslation ? locatedTranslation : undefined,
        translatedEnd: validTranslatedRange ? proposedTranslatedEnd : uniqueTranslation ? locatedTranslation + translation.length : undefined,
        category: ["domain_term", "method", "model", "dataset", "acronym", "technical_phrase"].includes(String(term.category)) ? term.category : undefined,
        domain: String(term.domain ?? "").trim() || undefined,
        specialtyScore: Number.isFinite(Number(term.specialtyScore)) ? Math.min(1, Math.max(0, Number(term.specialtyScore))) : undefined,
        selectionReason: String(term.selectionReason ?? "").trim() || undefined,
      };
    }).filter((term) => !term.segmentId || segments.some((segment) => segment.id === term.segmentId));
    return {
      translatedText: segments.map((segment) => segment.translatedText).join(""),
      segments,
      terms,
      structured: segments.length > 0,
      missingSegmentIds,
      error: missingSegmentIds.length ? `模型返回缺少 ${missingSegmentIds.length} 个句段` : undefined,
    };
  } catch (error) {
    return {
      translatedText: response.trim(),
      segments: [{ id: "legacy", sourceStart: 0, sourceEnd: source.length, sourceText: source, translatedText: response.trim() }],
      terms: [],
      structured: false,
      missingSegmentIds: sourceSegments.map((segment) => segment.id),
      error: error instanceof Error ? `模型返回的结构化译文无法解析：${error.message}` : "模型返回的结构化译文无法解析",
    };
  }
}

export function contrastRatio(background: string, foreground: string): number {
  const luminance = (hex: string) => {
    const normalized = hex.replace("#", "");
    if (!/^[0-9a-f]{6}$/i.test(normalized)) return 0;
    const channels = [0, 2, 4].map((offset) => parseInt(normalized.slice(offset, offset + 2), 16) / 255)
      .map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const first = luminance(background);
  const second = luminance(foreground);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
