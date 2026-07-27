import { describe, expect, it } from "vitest";
import { isSensitiveProviderHeader, sanitizeProviderConfig } from "./providerConfig";

describe("provider configuration security", () => {
  it("recognizes credential-bearing headers case-insensitively", () => {
    expect(isSensitiveProviderHeader("Authorization")).toBe(true);
    expect(isSensitiveProviderHeader("X-API-Key")).toBe(true);
    expect(isSensitiveProviderHeader("x-vendor-api-key")).toBe(true);
    expect(isSensitiveProviderHeader("OpenAI-Organization")).toBe(false);
  });

  it("removes secrets before provider configuration is persisted or invoked", () => {
    const provider = sanitizeProviderConfig({
      id: "provider-test",
      name: "Test",
      format: "openai",
      baseUrl: "https://gateway.example/v1",
      credentialId: "provider-test",
      timeoutSeconds: 90,
      headers: {
        Authorization: "Bearer secret",
        "x-api-key": "secret",
        "OpenAI-Organization": "org-test",
      },
    });

    expect(provider.headers).toEqual({ "OpenAI-Organization": "org-test" });
    expect(JSON.stringify(provider)).not.toContain("secret");
  });
});
