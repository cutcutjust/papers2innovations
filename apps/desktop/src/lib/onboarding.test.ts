import { describe, expect, it } from "vitest";
import type { ModelConfig } from "@p2i/contracts";
import { modelHasCapability } from "./modelCapabilities";

const model = (capabilities?: ModelConfig["capabilities"]): ModelConfig => ({
  id: "model",
  providerId: "provider",
  model: "model",
  displayName: "Model",
  maxContextTokens: 128000,
  maxOutputTokens: 4096,
  capabilities,
});

describe("new-user model roles", () => {
  it("treats legacy models as text-only", () => {
    expect(modelHasCapability(model(), "text")).toBe(true);
    expect(modelHasCapability(model(), "vision")).toBe(false);
  });

  it("allows one multimodal model to satisfy both roles", () => {
    const multimodal = model(["text", "vision"]);
    expect(modelHasCapability(multimodal, "text")).toBe(true);
    expect(modelHasCapability(multimodal, "vision")).toBe(true);
  });
});
