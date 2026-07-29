import type { TranslationSegment, TranslationTerm } from "@p2i/contracts";

export interface StructuredTranslation {
  translatedText: string;
  segments: TranslationSegment[];
  terms: TranslationTerm[];
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
      let end = index + 1;
      while (end < source.length && /\s/.test(source[end])) end += 1;
      boundaries.push(end);
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
  }).filter(({ sourceStart, sourceEnd }) => source.slice(sourceStart, sourceEnd).trim());
  return rawSegments.map(({ sourceStart, sourceEnd }, index) => ({
    id: `sentence-${index + 1}`,
    sourceStart,
    sourceEnd,
    sourceText: source.slice(sourceStart, sourceEnd),
    translatedText: "",
  }));
}

export function structuredTranslationPrompt(source: string): string {
  const segments = splitTranslationSegments(source);
  return [
    "请按句翻译下面的学术文本。公式、引用、数字、Markdown 链接和图片标记必须原样保留。",
    "只返回 JSON，不要使用 Markdown 代码围栏。格式：",
    '{"segments":[{"id":"sentence-1","translatedText":"..."}],"terms":[{"text":"...","translation":"...","sourceStart":0,"sourceEnd":8,"literalMeaning":"...","contextMeaning":"...","explanation":"...","kind":"phrase|term","segmentId":"sentence-1"}]}',
    "segments 必须逐一返回且 id 不得改变；terms 只收录重要固定搭配和专业术语，sourceStart/sourceEnd 使用给定原文的绝对字符偏移。",
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
    const segments = sourceSegments.map((segment) => ({ ...segment, translatedText: values.get(segment.id) || segment.sourceText }));
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
      return {
        text,
        translation: String(term.translation),
        explanation: String(term.explanation ?? ""),
        kind: term.kind === "phrase" ? "phrase" as const : "term" as const,
        segmentId: term.segmentId ? String(term.segmentId) : undefined,
        sourceStart,
        sourceEnd,
        literalMeaning: String(term.literalMeaning ?? term.translation ?? ""),
        contextMeaning: String(term.contextMeaning ?? term.explanation ?? ""),
      };
    });
    return { translatedText: segments.map((segment) => segment.translatedText).join(""), segments, terms };
  } catch {
    return {
      translatedText: response.trim(),
      segments: [{ id: "legacy", sourceStart: 0, sourceEnd: source.length, sourceText: source, translatedText: response.trim() }],
      terms: [],
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
