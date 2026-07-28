export type FontSize = "small" | "medium" | "large";

export function normalizeFontSize(value: string | null): FontSize {
  return value === "small" || value === "large" ? value : "medium";
}
