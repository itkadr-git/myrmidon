// server/src/myrmidon/auth-401-burst/attention.ts
// myrmidon(OPE-11890): the board signal behind an authentication-401 burst.
//
// The detector (metrics.ts) latches `tripped` when the sliding window crosses
// the threshold. This module turns that latch into ONE attention card per
// company viewing the feed — the same process-level-registry shape the
// stale-block signal uses (myrmidon/stale-block/attention.ts): the feed reads
// the registry on the fly, no notification store. The card stays up while the
// latch is set; the operator dismisses it, and ADM resets the latch (or the
// process restarts) to clear it.
//
// No secret ever reaches this module: the signal carries only counts,
// thresholds, window and an ISO trippedAt — never a header, token, or key.

import type { AttentionSeverity } from "@myrmidon/shared";
import type { Auth401BurstSample } from "./metrics.js";

export interface Auth401BurstSignal {
  /** ISO timestamp of the first 401 that tripped the latch. */
  trippedAt: string;
  /** 401s inside the tripping window. */
  windowTotal: number;
  threshold: number;
  windowMs: number;
  /** Per-reason counts over the process lifetime (cumulative). */
  counts: Record<string, number>;
  /** Whether the latch is still set (the card exists only while it is). */
  tripped: boolean;
}

/** The detector calls this when the latch trips; idempotent while latched. */
export function recordAuth401BurstSignal(sample: Auth401BurstSample): void {
  if (!sample.tripped) return;
  latchedSignal = {
    trippedAt: sample.trippedAt ?? new Date().toISOString(),
    windowTotal: sample.windowTotal,
    threshold: sample.threshold,
    windowMs: sample.windowMs,
    counts: { ...sample.counts },
    tripped: true,
  };
}

let latchedSignal: Auth401BurstSignal | null = null;

/** The card exists exactly while the latch is set. */
export function readAuth401BurstSignal(): Auth401BurstSignal | null {
  return latchedSignal && latchedSignal.tripped ? latchedSignal : null;
}

/** Test helper: clear the latched signal. */
export function resetAuth401BurstSignal(): void {
  latchedSignal = null;
}

/** Stable dedup key: one card per trip; a re-trip after reset mints a new key. */
export function auth401BurstSignalDedupKey(signal: Auth401BurstSignal): string {
  return `auth_401_burst:${signal.trippedAt}`;
}

/** Why-now line for the card. Never includes request specifics. */
export function auth401BurstSignalWhyNow(signal: Auth401BurstSignal): string {
  return `The board detected a burst of ${signal.windowTotal} authentication 401s within ${Math.round(
    signal.windowMs / 1000,
  )}s (threshold ${signal.threshold}); requests are being rejected faster than normal. Check for a misconfigured or revoked key, a replaying client, or an active probing attempt. No credentials are logged.`;
}

/** Severity: a 401 storm is an active-auth stop, ranked with the other auth/ops alerts. */
export function auth401BurstSignalSeverity(): AttentionSeverity {
  return "high";
}
