// server/src/myrmidon/model-providers/signals.ts
//
// myrmidon(1.6.6 OPE-7198): attention signals for banned or limit-exhausted
// accounts in the Codex / ChatGPT subscription pool.
//
// When an account is:
//  - BANNED (token_expired / 401 / 403 / revoked access):
//    The account is out of rotation; operator/lead attention is required to
//    relogin or replace the account. Severity: high.
//  - EXHAUSTED (rate_limited / 100% window limit reached):
//    The account is out of rotation until the window reset timestamp.
//    Severity: medium.
//
// Signal lifecycle follows the same process-level registry pattern that
// litellm-fallback-signal and tracing-health use:
//  - evaluateAccountSignals: pure evaluator turning channels into typed signals.
//  - recordPoolAccountSignals / readPoolAccountSignals: in-memory company-scoped
//    signal store read by the attention feed (attention.ts).

import type {
  PoolAccountChannelView,
  PoolAccountRoleSignal,
} from "@paperclipai/shared";

export const CODEX_POOL_ALERT_DEDUP_PREFIX = "codex_pool:";

export function codexPoolBannedDedupKey(companyId: string, accountNumber: number): string {
  return `${CODEX_POOL_ALERT_DEDUP_PREFIX}ban:${companyId}:${accountNumber}`;
}

export function codexPoolExhaustedDedupKey(
  companyId: string,
  accountNumber: number,
  resetsAt: number | null,
): string {
  return `${CODEX_POOL_ALERT_DEDUP_PREFIX}exhausted:${companyId}:${accountNumber}:${resetsAt ?? "window"}`;
}

/**
 * Pure evaluator: evaluates a list of pool account channels and generates
 * role signals for banned or exhausted accounts.
 */
export function evaluateAccountSignals(
  companyId: string,
  accounts: PoolAccountChannelView[],
  nowDate: Date = new Date(),
): PoolAccountRoleSignal[] {
  const signals: PoolAccountRoleSignal[] = [];
  const isoNow = nowDate.toISOString();

  for (const acc of accounts) {
    if (acc.isBanned) {
      signals.push({
        dedupKey: codexPoolBannedDedupKey(companyId, acc.n),
        accountNumber: acc.n,
        label: acc.label,
        kind: "banned",
        severity: "high",
        title: `Codex/ChatGPT account #${acc.n} (${acc.label}) banned / token expired`,
        whyNow:
          `Account #${acc.n} (${acc.label}) token has expired or access was revoked (state: ${acc.state}). ` +
          "The account was taken out of rotation. Relogin or replace account credentials.",
        summaryExcerpt: `Account #${acc.n} (${acc.label}) banned/expired`,
        resetsAt: null,
        activityAt: isoNow,
      });
      // A banned account takes precedence over exhaustion
      continue;
    }

    if (acc.isExhausted) {
      const resetUnix = acc.limitedUntil ?? acc.windows.primary?.resetsAt ?? null;
      const resetTimeStr = resetUnix
        ? new Date(resetUnix * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
        : "window reset";
      const usedPct = acc.windows.primary?.usedPct ?? 100;
      signals.push({
        dedupKey: codexPoolExhaustedDedupKey(companyId, acc.n, resetUnix),
        accountNumber: acc.n,
        label: acc.label,
        kind: "exhausted",
        severity: "medium",
        title: `Codex/ChatGPT account #${acc.n} (${acc.label}) quota exhausted`,
        whyNow:
          `Account #${acc.n} (${acc.label}) reached ${usedPct}% quota. ` +
          `It was removed from router rotation until ${resetTimeStr}.`,
        summaryExcerpt: `Account #${acc.n} (${acc.label}) exhausted (${usedPct}%)`,
        resetsAt: resetUnix,
        activityAt: isoNow,
      });
    }
  }

  return signals;
}

// ---------------------------------------------------------------------------
// In-memory process-level registry for the attention feed
// ---------------------------------------------------------------------------

const poolSignalsByCompany = new Map<string, PoolAccountRoleSignal[]>();

/** Records the active pool signals for a company; an empty array clears them. */
export function recordPoolAccountSignals(
  companyId: string,
  signals: PoolAccountRoleSignal[],
): void {
  if (signals.length === 0) {
    poolSignalsByCompany.delete(companyId);
    return;
  }
  poolSignalsByCompany.set(companyId, signals);
}

/** Reads active pool account signals for a company. */
export function readPoolAccountSignals(companyId: string): PoolAccountRoleSignal[] {
  return poolSignalsByCompany.get(companyId) ?? [];
}

/** Clears stored pool account signals. */
export function clearPoolAccountSignals(companyId?: string): void {
  if (companyId) {
    poolSignalsByCompany.delete(companyId);
  } else {
    poolSignalsByCompany.clear();
  }
}
