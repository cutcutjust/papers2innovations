import type { PromptTemplate, PromptTemplateCategory } from "@p2i/contracts";
import { BookOpenText, Languages, Lightbulb, MessageSquareText, WandSparkles, type LucideIcon } from "lucide-react";

export interface PromptCategoryDefinition {
  id: PromptTemplateCategory;
  label: string;
  description: string;
  icon: LucideIcon;
}

export const PROMPT_CATEGORIES: PromptCategoryDefinition[] = [
  { id: "reader", label: "阅读助手", description: "论文问答与上下文推理", icon: MessageSquareText },
  { id: "translation", label: "翻译", description: "段落、术语与单词翻译", icon: Languages },
  { id: "explanation", label: "解释", description: "公式、方法与论断解释", icon: BookOpenText },
  { id: "markdown", label: "Markdown 整理", description: "结构、换行与 OCR 断词整理", icon: WandSparkles },
  { id: "innovation", label: "创新工作台", description: "研究空白与创新点提炼", icon: Lightbulb },
];

export const DEFAULT_PROMPT_TEMPLATES: PromptTemplate[] = [
  { id: "prompt-library:reader:default", category: "reader", name: "循证论文问答", content: "你是阅读器中的论文分析助手。请默认使用中文，只根据提供的本地论文上下文回答。每条事实性陈述都要尽可能引用论文、章节、文本块或页码；区分直接证据与推断，上下文不足时明确说明。行内公式使用 $...$，块级公式使用 $$...$$。", sortOrder: 0, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
  { id: "prompt-library:translation:default", category: "translation", name: "忠实学术翻译", content: "请将科研文本忠实翻译为简体中文。保留 Markdown、LaTeX、专业术语、引用、数字和不确定性，只返回译文，不要添加解释。行内公式使用 $...$，块级公式使用 $$...$$。", sortOrder: 0, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
  { id: "prompt-library:explanation:default", category: "explanation", name: "严谨论文解释", content: "请用中文严谨解释给定的科研内容，说明核心命题、必要假设、推理过程、作用、局限与未解决问题。不得虚构证明或结论，并引用提供的章节、文本块或页码锚点。保留原有 LaTeX。", sortOrder: 0, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
  { id: "prompt-library:markdown:default", category: "markdown", name: "无损 Markdown 整理", content: "你是无损科研 Markdown 整理助手。只改善结构和可读性：重建合理段落与换行，规范标题和列表，让每条参考文献独立成行，并修复明显的 OCR 断词连字符。禁止摘要、翻译、改写论点、修改引用、数字、名称、公式、表格、图片路径或添加内容。必须原样保留证据锚点，只返回 Markdown。", sortOrder: 0, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
  { id: "prompt-library:innovation:default", category: "innovation", name: "循证创新点提炼", content: "基于 {paper_context} 比较研究问题、方法、数据、指标和局限，区分论文直接证据与合理推断。提炼尚未解决的研究空白，提出可验证的新研究问题，并为每个想法给出假设、最小实验、失败条件和证据锚点。默认使用中文，不得虚构来源。", sortOrder: 0, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
];

const selectionKey = (category: PromptTemplateCategory) => `p2i.prompt-template.${category}`;

export function selectedPromptId(category: PromptTemplateCategory): string {
  return typeof window === "undefined" ? "" : window.localStorage.getItem(selectionKey(category)) ?? "";
}

export function selectPromptTemplate(category: PromptTemplateCategory, id: string): void {
  if (typeof window !== "undefined") window.localStorage.setItem(selectionKey(category), id);
}

export function resolvePromptTemplate(templates: PromptTemplate[], category: PromptTemplateCategory, selectedId = selectedPromptId(category)): PromptTemplate | undefined {
  const candidates = templates.filter((template) => template.category === category);
  return candidates.find((template) => template.id === selectedId) ?? candidates[0];
}
