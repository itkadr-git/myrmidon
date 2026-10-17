// The operator signal behind a pause-guard pass that could not finish its work
// (myrmidon 1.6.5 PAUSE-GUARD).
//
// One pass resumes at most `maxResumesPerPass` agents. When there are more
// forgotten operator pauses than that, the guard deliberately leaves the rest
// for the next pass — the ceiling is what keeps a fleet-wide resume after a
// long night from starting every stranded backlog at the same instant. The
// operator still has to know: the remainder is raised as ONE card on the
// attention desk per company, and it disappears as soon as a pass finds
// nothing left over.
//
// The card is computed on the fly by the attention feed from a process-level
// registry this module owns — the same one-signal-per-company shape the LLM
// tracing signal and the stale-block signal use. No new notification store,
// no row to migrate: while the process lives the signal is fresh, and every
// pass writes its own audit line into the activity log either way.

import type { AttentionSeverity } from "@paperclipai/shared";

/** Stable dedup prefix: one card per company, refreshed by every pass. */
export const PAUSE_GUARD_ATTENTION_DEDUP_PREFIX = "pause_guard";

export interface PauseGuardAttentionSignal {
  companyId: string;
  /** Forgotten operator pauses this pass left for the next one. */
  deferredCount: number;
  /** Operator pauses this pass resumed. */
  resumedCount: number;
  /** The threshold the pass used, in minutes. */
  thresholdMinutes: number;
  /** ISO timestamp of the pass the signal was built from. */
  activityAt: string;
}

const signalByCompany = new Map<string, PauseGuardAttentionSignal>();

/** Record (or clear) the company's leftover-pauses signal after a pass. */
export function recordPauseGuardSignal(
  companyId: string,
  signal: Omit<PauseGuardAttentionSignal, "companyId"> | null,
): void {
  if (!signal || signal.deferredCount <= 0) {
    signalByCompany.delete(companyId);
    return;
  }
  signalByCompany.set(companyId, { companyId, ...signal });
}

/** The current leftover-pauses signal for a company, or null. */
export function readPauseGuardSignal(companyId: string): PauseGuardAttentionSignal | null {
  return signalByCompany.get(companyId) ?? null;
}

/** Every company that currently carries the card; a pass clears the stale ones. */
export function pauseGuardSignalCompanyIds(): string[] {
  return [...signalByCompany.keys()];
}

/** Test helper: forget every recorded signal. */
export function resetPauseGuardSignals(): void {
  signalByCompany.clear();
}

/** Stable dedup key: one card per company while a pass keeps leaving work over. */
export function pauseGuardSignalDedupKey(companyId: string): string {
  return `${PAUSE_GUARD_ATTENTION_DEDUP_PREFIX}:${companyId}`;
}

/** Title of the operator card. */
export function pauseGuardSignalTitle(signal: PauseGuardAttentionSignal): string {
  return "Forgotten pauses left over";
}

/** Why-now line: what the pass did and what is still waiting. */
export function pauseGuardSignalWhyNow(signal: PauseGuardAttentionSignal): string {
  const resumed = signal.resumedCount > 0 ? `${signal.resumedCount} resumed` : "none resumed";
  return `The pause guard resumed operator pauses older than ${signal.thresholdMinutes} minutes and stopped at its per-pass ceiling: ${resumed}, ${signal.deferredCount} still paused. They are resumed on the following passes; raise the per-pass ceiling in Settings if the backlog has to clear at once.`;
}

/**
 * Severity: the guard is working through the backlog on its own, so this is a
 * notice about a queue, not a stop.
 */
export function pauseGuardSignalSeverity(): AttentionSeverity {
  return "low";
}

/**
 * A deterministic, uuid-shaped subject id for the company-level card. The
 * attention enrichment joins subject ids against uuid columns, so a readable
 * string id breaks the feed query; this keeps the card joinable, unique per
 * company and stable across reads.
 */
export function pauseGuardSubjectId(companyId: string): string {
  const hex = companyId.replaceAll("-", "").replaceAll(/[^0-9a-f]/gi, "0").padEnd(24, "0").slice(0, 24);
  const body = `00000000${hex}`.padEnd(32, "0").slice(0, 32);
  return `${body.slice(0, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}-${body.slice(16, 20)}-${body.slice(20, 32)}`;
}