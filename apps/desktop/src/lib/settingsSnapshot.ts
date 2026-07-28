import type { ModelConfig, ProviderConfig } from "@p2i/contracts";
import type { FontSize } from "./fontSize";

export interface WorkspaceSettingsSnapshot {
  version: 1;
  root: string;
  providers: ProviderConfig[];
  customModels: ModelConfig[];
  contextCompressionModelId: string;
  markdownFormattingModelId: string;
  autoFormatMarkdown: boolean;
  fullPageOcrModelId: string;
  ocrConsent: boolean;
  fontSize: FontSize;
}

export function isWorkspaceSettingsSnapshot(value: unknown): value is WorkspaceSettingsSnapshot {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<WorkspaceSettingsSnapshot>;
  return item.version === 1
    && typeof item.root === "string"
    && Array.isArray(item.providers)
    && item.providers.length > 0
    && Array.isArray(item.customModels)
    && item.customModels.length > 0
    && typeof item.contextCompressionModelId === "string"
    && typeof item.markdownFormattingModelId === "string"
    && typeof item.autoFormatMarkdown === "boolean"
    && typeof item.fullPageOcrModelId === "string"
    && typeof item.ocrConsent === "boolean"
    && ["small", "medium", "large"].includes(item.fontSize ?? "");
}
