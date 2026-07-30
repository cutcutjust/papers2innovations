import type { ReaderAnnotation, TranslationTerm } from "@p2i/contracts";

export interface ReaderTranslationRange {
  recordId: string;
  segmentId: string;
  sourceStart: number;
  sourceEnd: number;
  sourceText: string;
  translatedText: string;
  terms: TranslationTerm[];
}

interface AstPosition {
  start?: { offset?: number };
  end?: { offset?: number };
}

interface AstNode {
  type: string;
  value?: string;
  children?: AstNode[];
  position?: AstPosition;
  data?: Record<string, unknown>;
}

export interface ReaderAnnotationPluginOptions {
  source: string;
  /** @deprecated Kept for older callers and migration tests. */
  view?: "original" | "translated";
  activeTranslationKeys?: ReadonlySet<string>;
  annotationsVisible?: boolean;
  translations: ReaderTranslationRange[];
  annotations: ReaderAnnotation[];
}

const ATOMIC_NODE_TYPES = new Set(["code", "inlineCode", "math", "inlineMath", "image", "imageReference", "link", "linkReference"]);

const overlaps = (start: number, end: number, rangeStart: number, rangeEnd: number) => start < rangeEnd && end > rangeStart;

export const readerTranslationKey = (recordId: string, segmentId: string) => `${recordId}:${segmentId}`;

function dataList(values: string[]): string {
  return [...new Set(values.filter(Boolean))].join(",");
}

export function createReaderAnnotationPlugin(options: ReaderAnnotationPluginOptions) {
  const annotationsVisible = options.annotationsVisible !== false;
  const translationIsActive = (range: ReaderTranslationRange) => annotationsVisible && (
    options.activeTranslationKeys?.has(readerTranslationKey(range.recordId, range.segmentId))
    ?? options.view === "translated"
  );
  return () => (tree: AstNode) => {
    if (!annotationsVisible) return;
    const walk = (node: AstNode) => {
      if (!node.children || ATOMIC_NODE_TYPES.has(node.type)) return;
      const nextChildren: AstNode[] = [];
      for (const child of node.children) {
        const start = child.position?.start?.offset;
        const end = child.position?.end?.offset;
        if (child.type !== "text" || start === undefined || end === undefined || end <= start) {
          walk(child);
          nextChildren.push(child);
          continue;
        }
        const raw = options.source.slice(start, end);
        if (raw.length !== child.value?.length) {
          nextChildren.push({
            type: "emphasis",
            children: [child],
            data: { hName: "span", hProperties: { "data-source-start": start, "data-source-end": end, "data-source-exact": "false" } },
          });
          continue;
        }
        const relevantTranslations = annotationsVisible
          ? options.translations.filter((range) => overlaps(start, end, range.sourceStart, range.sourceEnd))
          : [];
        const relevantAnnotations = annotationsVisible
          ? options.annotations.filter((annotation) => overlaps(start, end, annotation.sourceStart, annotation.sourceEnd))
          : [];
        const boundaries = new Set([start, end]);
        for (const range of relevantTranslations) {
          boundaries.add(Math.max(start, range.sourceStart));
          boundaries.add(Math.min(end, range.sourceEnd));
        }
        for (const annotation of relevantAnnotations) {
          const insideTranslation = relevantTranslations.some((range) => translationIsActive(range) && (
            annotation.sourceStart > range.sourceStart && annotation.sourceStart < range.sourceEnd
          ));
          if (!insideTranslation) boundaries.add(Math.max(start, annotation.sourceStart));
          const endInsideTranslation = relevantTranslations.some((range) => translationIsActive(range) && (
            annotation.sourceEnd > range.sourceStart && annotation.sourceEnd < range.sourceEnd
          ));
          if (!endInsideTranslation) boundaries.add(Math.min(end, annotation.sourceEnd));
        }
        const sorted = [...boundaries].sort((left, right) => left - right);
        sorted.slice(0, -1).forEach((runStart, index) => {
          const runEnd = sorted[index + 1];
          if (runEnd <= runStart) return;
          const translation = relevantTranslations.find((range) => range.sourceStart === runStart && range.sourceEnd === runEnd);
          const translationMarker = translation ?? relevantTranslations.find((range) => overlaps(runStart, runEnd, range.sourceStart, range.sourceEnd));
          const chatAnnotations = relevantAnnotations.filter((annotation) => annotation.annotationType === "chat" && overlaps(runStart, runEnd, annotation.sourceStart, annotation.sourceEnd));
          const translationAnnotations = relevantAnnotations.filter((annotation) => annotation.annotationType === "translation" && overlaps(runStart, runEnd, annotation.sourceStart, annotation.sourceEnd));
          const translated = Boolean(translation?.translatedText && translationIsActive(translation));
          const classes = [
            "reader-annotated-run",
            translated ? "translated-replacement" : "",
            translationMarker || translationAnnotations.length ? "has-translation-marker" : "",
            chatAnnotations.length ? "has-chat-marker" : "",
          ].filter(Boolean).join(" ");
          nextChildren.push({
            type: "emphasis",
            children: [{ type: "text", value: translated ? translation!.translatedText : options.source.slice(runStart, runEnd) }],
            data: {
              hName: "span",
              hProperties: {
                className: classes,
                "data-source-start": runStart,
                "data-source-end": runEnd,
                "data-source-exact": translated ? "false" : "true",
                "data-translation-id": translationMarker?.recordId ?? translationAnnotations[0]?.relatedId ?? "",
                "data-translation-segment-id": translationMarker?.segmentId ?? "",
                "data-translation-key": translationMarker ? readerTranslationKey(translationMarker.recordId, translationMarker.segmentId) : "",
                "data-translation-active": translated ? "true" : "false",
                "data-chat-annotation-ids": dataList(chatAnnotations.map((annotation) => annotation.id)),
              },
            },
          });
        });
      }
      node.children = nextChildren;
    };
    walk(tree);
  };
}

function sourceElement(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const element = node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : node.parentElement;
  return element?.closest<HTMLElement>("[data-source-start][data-source-end]") ?? null;
}

function textOffsetWithin(element: HTMLElement, container: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(element);
  try {
    range.setEnd(container, offset);
    return range.toString().length;
  } catch {
    return 0;
  }
}

function domPointForSourceOffset(root: HTMLElement, sourceOffset: number, edge: "start" | "end"): { node: Node; offset: number } | undefined {
  const elements = Array.from(root.querySelectorAll<HTMLElement>("[data-source-start][data-source-end]"));
  const element = elements.find((candidate) => {
    const start = Number(candidate.dataset.sourceStart);
    const end = Number(candidate.dataset.sourceEnd);
    return Number.isFinite(start) && Number.isFinite(end) && (edge === "start" ? sourceOffset >= start && sourceOffset < end : sourceOffset > start && sourceOffset <= end);
  }) ?? elements.find((candidate) => Number(candidate.dataset.sourceStart) === sourceOffset || Number(candidate.dataset.sourceEnd) === sourceOffset);
  if (!element) return undefined;
  const start = Number(element.dataset.sourceStart);
  const end = Number(element.dataset.sourceEnd);
  if (element.dataset.sourceExact !== "true") return { node: element, offset: edge === "start" ? 0 : element.childNodes.length };
  const target = Math.max(0, Math.min(end - start, sourceOffset - start));
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let remaining = target;
  let node = walker.nextNode();
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) return { node, offset: remaining };
    remaining -= length;
    node = walker.nextNode();
  }
  return { node: element, offset: element.childNodes.length };
}

export function domRangeFromSourceRange(root: HTMLElement, start: number, end: number): Range | undefined {
  const startPoint = domPointForSourceOffset(root, start, "start");
  const endPoint = domPointForSourceOffset(root, end, "end");
  if (!startPoint || !endPoint) return undefined;
  const range = document.createRange();
  try {
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, endPoint.offset);
    return range;
  } catch {
    return undefined;
  }
}

export function sourceOffsetFromDomPoint(container: Node, offset: number): number | undefined {
  const element = sourceElement(container);
  if (!element) return undefined;
  const start = Number(element.dataset.sourceStart);
  const end = Number(element.dataset.sourceEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  if (element.dataset.sourceExact !== "true") return start;
  return Math.min(end, start + textOffsetWithin(element, container, offset));
}

export function sentenceRangeAtOffset(source: string, offset: number): { start: number; end: number; text: string } | undefined {
  if (!source.trim()) return undefined;
  const normalizedOffset = Math.min(Math.max(0, offset), Math.max(0, source.length - 1));
  let start = normalizedOffset;
  let end = normalizedOffset;
  while (start > 0 && !/[.!?。！？\n]/.test(source[start - 1])) start -= 1;
  while (end < source.length && !/[.!?。！？\n]/.test(source[end])) end += 1;
  if (end < source.length && /[.!?。！？]/.test(source[end])) end += 1;
  while (start < end && /\s/.test(source[start])) start += 1;
  while (end > start && /\s/.test(source[end - 1])) end -= 1;
  if (end <= start) return undefined;
  return { start, end, text: source.slice(start, end) };
}

export function sourceRangeFromDomRange(range: Range, source: string): { start: number; end: number; text: string } | undefined {
  const startElement = sourceElement(range.startContainer);
  const endElement = sourceElement(range.endContainer);
  if (!startElement || !endElement) return undefined;
  const startBase = Number(startElement.dataset.sourceStart);
  const startLimit = Number(startElement.dataset.sourceEnd);
  const endBase = Number(endElement.dataset.sourceStart);
  const endLimit = Number(endElement.dataset.sourceEnd);
  if (![startBase, startLimit, endBase, endLimit].every(Number.isFinite)) return undefined;
  const start = startElement.dataset.sourceExact === "true"
    ? Math.min(startLimit, startBase + textOffsetWithin(startElement, range.startContainer, range.startOffset))
    : startBase;
  const end = endElement.dataset.sourceExact === "true"
    ? Math.min(endLimit, endBase + textOffsetWithin(endElement, range.endContainer, range.endOffset))
    : endLimit;
  let normalizedStart = Math.min(start, end);
  let normalizedEnd = Math.max(start, end);
  while (normalizedStart < normalizedEnd && /\s/.test(source[normalizedStart])) normalizedStart += 1;
  while (normalizedEnd > normalizedStart && /\s/.test(source[normalizedEnd - 1])) normalizedEnd -= 1;
  if (normalizedEnd <= normalizedStart) return undefined;
  return { start: normalizedStart, end: normalizedEnd, text: source.slice(normalizedStart, normalizedEnd) };
}
