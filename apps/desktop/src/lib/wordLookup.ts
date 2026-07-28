import type { ModelMessage } from "@p2i/contracts";

export interface PaperWordContext {
  paperTitle: string;
  sectionTitle: string;
  outline: string[];
  selectedParagraph: string;
  adjacentText: string;
  paperExcerpt: string;
}

export function isSingleEnglishWord(text: string): boolean {
  return /^[A-Za-z]+(?:['’-][A-Za-z]+)*$/.test(text.trim());
}

export function buildWordLookupMessages(word: string, context: PaperWordContext): ModelMessage[] {
  return [
    {
      role: "system",
      content: "你是面向中文科研读者的英文论文词典。请用简体中文解释单词，必须包含：英式/美式 IPA、词性、常见义项、当前论文中的准确语境义、所在短语或搭配、一个贴合本文的中英例句，以及容易混淆的近义词。先区分通用词义和本文义，不得脱离上下文猜测。使用紧凑 Markdown，只返回查词结果。",
    },
    {
      role: "user",
      content: `待查单词：${word}\n\n论文标题：${context.paperTitle}\n当前章节：${context.sectionTitle}\n全文目录：\n${context.outline.map((title) => `- ${title}`).join("\n")}\n\n单词所在段落：\n${context.selectedParagraph}\n\n相邻段落：\n${context.adjacentText}\n\n论文全文节选：\n${context.paperExcerpt}`,
    },
  ];
}
