import type { ModelConfig, ProviderConfig } from "@p2i/contracts";
import type { FontSize } from "./fontSize";

export interface WorkspaceSettingsSnapshot {
  version: 1 | 2 | 3;
  root: string;
  providers: ProviderConfig[];
  customModels: ModelConfig[];
  contextCompressionModelId: string;
  markdownFormattingModelId: string;
  autoFormatMarkdown: boolean;
  fullPageOcrModelId: string;
  ocrConsent: boolean;
  fontSize: FontSize;
  visionAnalysisModelId?: string;
  readerZoom?: number;
  readerTheme?: "white" | "warm" | "green" | "dark" | "custom";
  readerBackgroundColor?: string;
  readerTextColor?: string;
  readerTranslationView?: "original" | "translated";
  readerAnnotationsVisible?: boolean;
  defaultTextModelId?: string;
  onboardingVersion?: number;
}

export function isWorkspaceSettingsSnapshot(value: unknown): value is WorkspaceSettingsSnapshot {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<WorkspaceSettingsSnapshot>;
  const supportedVersion = item.version === 1 || item.version === 2 || item.version === 3;
  const validRegistry = Array.isArray(item.providers)
    && Array.isArray(item.customModels)
    && (item.version === 3 || (item.providers.length > 0 && item.customModels.length > 0));
  return supportedVersion
    && typeof item.root === "string"
    && validRegistry
    && typeof item.contextCompressionModelId === "string"
    && typeof item.markdownFormattingModelId === "string"
    && typeof item.autoFormatMarkdown === "boolean"
    && typeof item.fullPageOcrModelId === "string"
    && typeof item.ocrConsent === "boolean"
    && (item.readerAnnotationsVisible === undefined || typeof item.readerAnnotationsVisible === "boolean")
    && (item.defaultTextModelId === undefined || typeof item.defaultTextModelId === "string")
    && (item.onboardingVersion === undefined || (Number.isInteger(item.onboardingVersion) && item.onboardingVersion >= 0))
    && ["small", "medium", "large"].includes(item.fontSize ?? "");
}
