import type { ContextSourceItem, ModelMessage } from "@p2i/contracts";

export const CONTEXT_COMPRESSION_PROMPT_VERSION = "context-compress-v1";

export function contextCompressionMessages(source: ContextSourceItem): ModelMessage[] {
  return [
    {
      role: "system",
      content: "请将科研论文上下文压缩为供后续研究智能体使用的中文 Markdown。完整保留论点、方法、数据集、定量结果、局限性、不确定性、引用，以及所有可用的章节/页码/文本块锚点。使用简洁且以证据为中心的标题，不得补充事实或擅自填补缺失信息。只返回压缩后的上下文。",
    },
    {
      role: "user",
      content: `论文：${source.paperTitle}\n来源哈希：${source.sourceHash}\n\n${source.sourceText}`,
    },
  ];
}

export function contextCompressionBudgetError(sourceTokens: number, maxContextTokens: number, maxOutputTokens: number): string | undefined {
  const fixedReserve = 12_000;
  const available = Math.max(0, maxContextTokens - maxOutputTokens - fixedReserve);
  if (sourceTokens <= available) return undefined;
  return `该来源约需 ${sourceTokens.toLocaleString()} 个输入 token，但所选模型仅剩约 ${available.toLocaleString()} 个。请选择更长上下文的模型，或只添加所需章节。`;
}
