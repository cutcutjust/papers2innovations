import { describe, expect, it } from "vitest";
import { isWorkspaceSettingsSnapshot } from "./settingsSnapshot";

const valid = {
  version: 1,
  root: "E:/Library",
  providers: [{ id: "provider", name: "Provider", format: "openai", baseUrl: "https://example.com/v1", credentialId: "provider", timeoutSeconds: 90 }],
  customModels: [{ id: "model", providerId: "provider", displayName: "Model", model: "model", maxContextTokens: 128000, maxOutputTokens: 4096 }],
  contextCompressionModelId: "model",
  markdownFormattingModelId: "model",
  autoFormatMarkdown: true,
  fullPageOcrModelId: "",
  ocrConsent: false,
  fontSize: "medium",
};

describe("workspace settings snapshot", () => {
  it("accepts a complete non-secret snapshot", () => {
    expect(isWorkspaceSettingsSnapshot(valid)).toBe(true);
    expect(JSON.stringify(valid)).not.toContain("apiKey");
  });

  it("accepts v2 reader and vision preferences while retaining v1 compatibility", () => {
    expect(isWorkspaceSettingsSnapshot({
      ...valid,
      version: 2,
      visionAnalysisModelId: "model",
      readerZoom: 125,
      readerTheme: "green",
      readerBackgroundColor: "#edf5ee",
      readerTextColor: "#203027",
      readerTranslationView: "translated",
      readerAnnotationsVisible: false,
    })).toBe(true);
    expect(isWorkspaceSettingsSnapshot(valid)).toBe(true);
  });

  it("rejects incomplete or unsupported snapshots", () => {
    expect(isWorkspaceSettingsSnapshot({ ...valid, providers: [] })).toBe(false);
    expect(isWorkspaceSettingsSnapshot({ ...valid, fontSize: "huge" })).toBe(false);
    expect(isWorkspaceSettingsSnapshot({ ...valid, readerAnnotationsVisible: "yes" })).toBe(false);
  });
});
