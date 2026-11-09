// server/src/myrmidon/model-providers/pool-rotation.ts
//
// myrmidon(1.6.6 OPE-10775): account rotation and sliding window allocation
// for Codex / ChatGPT subscription pools.
//
// Automatically excludes banned or limit-exhausted accounts (5-hour and 7-day
// windows) and switches rotation to the next available account.

import type { PoolAccountChannelView, PoolAccountLimitWindow } from "@myrmidon/shared";

export interface SelectPoolAccountOptions {
  model?: string;
  nowUnix?: number;
}

/**
 * Checks whether an individual pool limit window has reached its quota limit
 * and is still within its active blocking period.
 */
export function isWindowQuotaExhausted(
  window: PoolAccountLimitWindow | null | undefined,
  nowUnix: number,
): boolean {
  if (!window) return false;
  const reached =
    window.limitReached === true ||
    (typeof window.usedPct === "number" && window.usedPct >= 100);
  if (!reached) return false;

  // If resetsAt is specified and in the past, the window has reset and is no longer blocking.
  if (typeof window.resetsAt === "number" && window.resetsAt > 0 && window.resetsAt <= nowUnix) {
    return false;
  }
  return true;
}

/**
 * Checks whether an account is currently eligible for rotation.
 * Accounts that are banned, token-expired, or quota-exhausted on either the 5-hour
 * or weekly window are ineligible.
 */
export function isAccountEligibleForRotation(
  account: PoolAccountChannelView,
  nowUnix: number = Math.floor(Date.now() / 1000),
): boolean {
  // 1. Banned or authentication expired
  if (
    account.isBanned ||
    account.state === "banned" ||
    account.state === "token_expired" ||
    account.state === "login_expired"
  ) {
    return false;
  }

  // 2. Explicitly flagged as exhausted
  if (account.isExhausted) {
    return false;
  }

  // 3. Time-limited until a future timestamp
  if (account.limitedUntil !== null && account.limitedUntil > nowUnix) {
    return false;
  }

  // 4. 5-hour (primary) and weekly (secondary) sliding window checks
  if (isWindowQuotaExhausted(account.windows?.primary, nowUnix)) {
    return false;
  }
  if (isWindowQuotaExhausted(account.windows?.secondary, nowUnix)) {
    return false;
  }

  return true;
}

/**
 * Selects an eligible account from the pool for a request.
 * Automatically skips banned and window-exhausted accounts and selects the
 * least loaded eligible account.
 *
 * If the previously active account is exhausted, rotation switches to the
 * next available account.
 */
export function selectActivePoolAccount(
  channels: PoolAccountChannelView[],
  options?: SelectPoolAccountOptions,
): PoolAccountChannelView | null {
  const nowUnix = options?.nowUnix ?? Math.floor(Date.now() / 1000);

  const eligible = channels.filter((ch) => {
    if (!isAccountEligibleForRotation(ch, nowUnix)) {
      return false;
    }
    // Filter by requested model if specified
    if (options?.model && ch.models && ch.models.length > 0) {
      if (!ch.models.includes(options.model)) {
        return false;
      }
    }
    return true;
  });

  if (eligible.length === 0) {
    return null;
  }

  // Sort eligible accounts:
  // Least loaded first: compare maximum used percentage across active windows.
  // Deterministic tie-breaking by account number (n).
  eligible.sort((a, b) => {
    const aPrimaryPct = a.windows?.primary?.usedPct ?? 0;
    const aSecondaryPct = a.windows?.secondary?.usedPct ?? 0;
    const aMaxPct = Math.max(aPrimaryPct, aSecondaryPct);

    const bPrimaryPct = b.windows?.primary?.usedPct ?? 0;
    const bSecondaryPct = b.windows?.secondary?.usedPct ?? 0;
    const bMaxPct = Math.max(bPrimaryPct, bSecondaryPct);

    if (aMaxPct !== bMaxPct) {
      return aMaxPct - bMaxPct;
    }
    return a.n - b.n;
  });

  return eligible[0] ?? null;
}
