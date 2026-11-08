// myrmidon(1.6.3 PROMPT-BUDGET C): pure helpers of the advice panel.
// No React, no network — unit-testable as is.

/** The label of one recommendation's severity. */
export function adviceSeverityLabel(severity: "warn" | "crit"): string {
  return severity === "crit" ? "Critical" : "Warning";
}

/** A share as shown next to a part: whole percents stay whole, fractions keep one digit. */
export function formatSharePct(sharePct: number): string {
  if (!Number.isFinite(sharePct)) return "0%";
  const value = Math.max(0, sharePct);
  return Number.isInteger(value) ? `${value}%` : `${value.toFixed(1)}%`;
}

/** Token counts are read at a glance; keep them short. */
export function formatTokensShort(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens < 1000) return String(Math.round(tokens));
  return `${Math.round(tokens / 100) / 10}k`;
}

/** The issue route of a filed deep-analysis task. */
export function deepTaskHref(identifier: string): string {
  return `/issues/${encodeURIComponent(identifier)}`;
}