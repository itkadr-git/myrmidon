// server/src/myrmidon/litellm-sync/allowlist-report.ts
//
// myrmidon(1.6.7 OPE-12345): a log-safe summary of an allowlist pass result.
// Kept apart from the handler (pure, no database or gateway imports) so the
// startup check, the provider-change hook and the tests share one shape.

import type { AllowlistSyncResult } from "./agent-allowlist-handler.js";

/**
 * A short, log-safe summary of a pass result: counts, skip reasons and (dry
 * run) the most affected model names. No agent ids, secret names or values.
 */
export function summarizeAllowlistResult(result: AllowlistSyncResult | null | undefined) {
  const skippedByReason: Record<string, number> = {};
  for (const entry of result?.skipped ?? []) {
    const reason = entry.split(":")[0] ?? entry;
    skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1;
  }
  const top = (counts: Record<string, number>) =>
    Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 20));
  return {
    mode: result?.dryRun ? "dry-run" : "apply",
    attempted: result?.attempted ?? 0,
    updated: result?.updated ?? 0,
    skippedByReason,
    ...(result?.dryRun
      ? {
          keysToChange: result.dryRun.wouldChange,
          keysUnchanged: result.dryRun.unchanged,
          namesToAdd: top(result.dryRun.added),
          namesToRemove: top(result.dryRun.removed),
        }
      : {}),
  };
}
