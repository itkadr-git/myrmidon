// server/src/myrmidon/model-providers/signals.ts
//
// myrmidon(1.6.6 OPE-7198): attention signals for banned or limit-exhausted
// accounts in the Codex / ChatGPT subscription pool.
//
// When an account is:
//  - BANNED (token_expired / 401 / 403 / revoked access):
//    The account is out of rotation; operator/lead attention is required to
//    relogin or replace the account. Severity: high.
//  - EXHAUSTED (rate_limited / 100% window limit reached on 5h or weekly window):
//    The account is out of rotation until the effective blocking window reset timestamp.
//    Severity: medium.
//
// Signal lifecycle follows the process-level registry pattern:
//  - evaluateAccountSignals: pure evaluator turning channels into typed signals with
//    full primary (5-hour) and secondary (weekly) window awareness.
//  - recordPoolAccountSignals / readPoolAccountSignals: in-memory company/provider-scoped
//    signal store read by the attention feed (attention.ts).
//  - reportPoolAccountStatus: server-side event entry point to report account state changes.

import type {
  PoolAccountChannelView,
  PoolAccountRoleSignal,
} from "@myrmidonai/shared";

export const CODEX_POOL_ALERT_DEDUP_PREFIX = "codex_pool:";

export function codexPoolBannedDedupKey(
  companyId: string,
  providerId: string,
  accountNumber: number,
): string {
  return `${CODEX_POOL_ALERT_DEDUP_PREFIX}ban:${companyId}:${providerId}:${accountNumber}`;
}

export function codexPoolExhaustedDedupKey(
  companyId: string,
  providerId: string,
  accountNumber: number,
  resetsAt: number | null,
): string {
  return `${CODEX_POOL_ALERT_DEDUP_PREFIX}exhausted:${companyId}:${providerId}:${accountNumber}:${resetsAt ?? "window"}`;
}

/**
 * Pure evaluator: evaluates a list of pool account channels for a specific provider
 * and generates role signals for banned or exhausted accounts.
 */
export function evaluateAccountSignals(
  companyId: string,
  providerId: string,
  accounts: PoolAccountChannelView[],
  nowDate: Date = new Date(),
): PoolAccountRoleSignal[] {
  const signals: PoolAccountRoleSignal[] = [];
  const isoNow = nowDate.toISOString();

  for (const acc of accounts) {
    if (acc.isBanned) {
      signals.push({
        dedupKey: codexPoolBannedDedupKey(companyId, providerId, acc.n),
        providerId,
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
      const primary = acc.windows.primary;
      const secondary = acc.windows.secondary;

      const primaryExhausted = Boolean(
        primary?.usedPct !== null &&
          primary?.usedPct !== undefined &&
          primary.usedPct >= 100,
      );
      const secondaryExhausted = Boolean(
        secondary?.usedPct !== null &&
          secondary?.usedPct !== undefined &&
          secondary.usedPct >= 100,
      );

      let resetUnix: number | null = null;
      let usedPct = 100;
      let windowDesc = "quota limit";

      if (primaryExhausted && secondaryExhausted) {
        const candidateResets = [
          acc.limitedUntil,
          primary?.resetsAt,
          secondary?.resetsAt,
        ].filter((r): r is number => typeof r === "number" && r > 0);
        resetUnix = candidateResets.length > 0 ? Math.max(...candidateResets) : null;
        usedPct = Math.max(primary?.usedPct ?? 100, secondary?.usedPct ?? 100);
        windowDesc = "both 5-hour and weekly windows";
      } else if (secondaryExhausted) {
        const candidateResets = [acc.limitedUntil, secondary?.resetsAt].filter(
          (r): r is number => typeof r === "number" && r > 0,
        );
        resetUnix = candidateResets.length > 0 ? Math.max(...candidateResets) : (secondary?.resetsAt ?? null);
        usedPct = secondary?.usedPct ?? 100;
        windowDesc = "weekly window";
      } else if (primaryExhausted) {
        const candidateResets = [acc.limitedUntil, primary?.resetsAt].filter(
          (r): r is number => typeof r === "number" && r > 0,
        );
        resetUnix = candidateResets.length > 0 ? Math.max(...candidateResets) : (primary?.resetsAt ?? null);
        usedPct = primary?.usedPct ?? 100;
        windowDesc = "5-hour window";
      } else {
        const candidateResets = [
          acc.limitedUntil,
          primary?.resetsAt,
          secondary?.resetsAt,
        ].filter((r): r is number => typeof r === "number" && r > 0);
        resetUnix = candidateResets.length > 0 ? Math.max(...candidateResets) : null;
        usedPct = Math.max(primary?.usedPct ?? 0, secondary?.usedPct ?? 0) || 100;
        windowDesc = "quota limit";
      }

      const resetTimeStr = resetUnix
        ? new Date(resetUnix * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
        : "window reset";

      signals.push({
        dedupKey: codexPoolExhaustedDedupKey(companyId, providerId, acc.n, resetUnix),
        providerId,
        accountNumber: acc.n,
        label: acc.label,
        kind: "exhausted",
        severity: "medium",
        title: `Codex/ChatGPT account #${acc.n} (${acc.label}) quota exhausted`,
        whyNow:
          `Account #${acc.n} (${acc.label}) reached ${usedPct}% quota (${windowDesc}). ` +
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
// Scoped by companyId -> providerId -> PoolAccountRoleSignal[]
// ---------------------------------------------------------------------------

const poolSignalsByCompanyAndProvider = new Map<string, Map<string, PoolAccountRoleSignal[]>>();

/** Records the active pool signals for a specific company and provider. */
export function recordPoolAccountSignals(
  companyId: string,
  providerId: string,
  signals: PoolAccountRoleSignal[],
): void {
  let byProvider = poolSignalsByCompanyAndProvider.get(companyId);
  if (!byProvider) {
    byProvider = new Map();
    poolSignalsByCompanyAndProvider.set(companyId, byProvider);
  }

  if (signals.length === 0) {
    byProvider.delete(providerId);
    if (byProvider.size === 0) {
      poolSignalsByCompanyAndProvider.delete(companyId);
    }
    return;
  }

  byProvider.set(providerId, signals);
}

/** Reads all active pool account signals for a company, aggregated across all providers. */
export function readPoolAccountSignals(companyId: string): PoolAccountRoleSignal[] {
  const byProvider = poolSignalsByCompanyAndProvider.get(companyId);
  if (!byProvider) return [];
  const aggregated: PoolAccountRoleSignal[] = [];
  for (const list of byProvider.values()) {
    aggregated.push(...list);
  }
  return aggregated;
}

/** Reads active pool account signals for a specific provider. */
export function readProviderPoolAccountSignals(
  companyId: string,
  providerId: string,
): PoolAccountRoleSignal[] {
  const byProvider = poolSignalsByCompanyAndProvider.get(companyId);
  return byProvider?.get(providerId) ?? [];
}

/** Clears stored pool account signals. */
export function clearPoolAccountSignals(companyId?: string, providerId?: string): void {
  if (companyId && providerId) {
    const byProvider = poolSignalsByCompanyAndProvider.get(companyId);
    if (byProvider) {
      byProvider.delete(providerId);
      if (byProvider.size === 0) {
        poolSignalsByCompanyAndProvider.delete(companyId);
      }
    }
  } else if (companyId) {
    poolSignalsByCompanyAndProvider.delete(companyId);
  } else {
    poolSignalsByCompanyAndProvider.clear();
  }
}

/**
 * Server-side event entry point: updates or clears an individual account's signal.
 * Called when a router, worker or background sweep detects a change on an account.
 */
export function reportPoolAccountStatus(input: {
  companyId: string;
  providerId: string;
  account: PoolAccountChannelView;
  nowDate?: Date;
}): PoolAccountRoleSignal | null {
  const generated = evaluateAccountSignals(
    input.companyId,
    input.providerId,
    [input.account],
    input.nowDate,
  );
  const existing = readProviderPoolAccountSignals(input.companyId, input.providerId);
  const remaining = existing.filter((s) => s.accountNumber !== input.account.n);

  if (generated.length > 0) {
    const nextSignals = [...remaining, ...generated];
    recordPoolAccountSignals(input.companyId, input.providerId, nextSignals);
    return generated[0]!;
  }

  recordPoolAccountSignals(input.companyId, input.providerId, remaining);
  return null;
}
