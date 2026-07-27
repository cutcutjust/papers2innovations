import type { ProviderConfig } from "@p2i/contracts";

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
  "cookie",
  "set-cookie",
]);

export function isSensitiveProviderHeader(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return SENSITIVE_HEADER_NAMES.has(normalized) || normalized.endsWith("-api-key");
}

export function sanitizeProviderConfig(provider: ProviderConfig): ProviderConfig {
  const safeHeaders = Object.fromEntries(
    Object.entries(provider.headers ?? {}).filter(([name]) => !isSensitiveProviderHeader(name)),
  );
  return {
    ...provider,
    headers: Object.keys(safeHeaders).length ? safeHeaders : undefined,
  };
}
