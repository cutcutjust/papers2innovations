import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "@p2i/contracts";
import { providerRecoveryId } from "./credentials";

const provider = (patch: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: "provider-current",
  credentialId: "provider-current",
  name: "Model service",
  format: "openai",
  baseUrl: "https://example.com/compatible-mode/v1/",
  timeoutSeconds: 90,
  ...patch,
});

describe("provider credential recovery identity", () => {
  it("survives provider and credential ID changes", () => {
    expect(providerRecoveryId(provider())).toBe(providerRecoveryId(provider({
      id: "provider-after-upgrade",
      credentialId: "provider-after-upgrade",
    })));
  });

  it("changes when the API protocol or endpoint changes", () => {
    expect(providerRecoveryId(provider())).not.toBe(providerRecoveryId(provider({ format: "anthropic" })));
    expect(providerRecoveryId(provider())).not.toBe(providerRecoveryId(provider({ baseUrl: "https://other.example.com/v1" })));
  });
});
