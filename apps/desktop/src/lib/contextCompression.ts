import type { ContextSourceItem, ModelMessage } from "@p2i/contracts";

export const CONTEXT_COMPRESSION_PROMPT_VERSION = "context-compress-v1";

export function contextCompressionMessages(source: ContextSourceItem): ModelMessage[] {
  return [
    {
      role: "system",
      content: "Compress scientific paper context for downstream research agents. Preserve claims, methods, datasets, quantitative results, limitations, uncertainty, citations, and every available section/page/block anchor. Use concise Markdown with evidence-oriented headings. Do not add facts or resolve missing information. Return only the compressed context.",
    },
    {
      role: "user",
      content: `Paper: ${source.paperTitle}\nSource hash: ${source.sourceHash}\n\n${source.sourceText}`,
    },
  ];
}

export function contextCompressionBudgetError(sourceTokens: number, maxContextTokens: number, maxOutputTokens: number): string | undefined {
  const fixedReserve = 12_000;
  const available = Math.max(0, maxContextTokens - maxOutputTokens - fixedReserve);
  if (sourceTokens <= available) return undefined;
  return `This source needs about ${sourceTokens.toLocaleString()} input tokens, but the selected model has room for about ${available.toLocaleString()}. Choose a longer-context model or add selected sections instead.`;
}
