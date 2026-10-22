// myrmidon(FEATURES): the attention signal of the features page.
//
// A feature that is enabled and `misconfigured` or `failing` for more than 30
// minutes raises one card on the operator desk; the card disappears as soon as
// the feature is healthy, off or unknown again (no dismissal bookkeeping, the
// registry pattern the tracing and fallback signals use).
//
// The clock is the process: `brokenSince` is when a health pass first saw the
// feature broken, and a server restart restarts it. That errs on the quiet
// side (a card appears 30 minutes after a restart at the earliest), which is
// the right side for a signal that must not cry wolf.
//
// This module is deliberately light — the attention feed imports it — and does
// not import the registry or the database.

import {
  FEATURE_ATTENTION_AFTER_MS,
  isFeatureBroken,
  type FeatureHealthStatus,
} from "@paperclipai/shared";

export const FEATURE_ATTENTION_DEDUP_PREFIX = "feature_health:";

export interface FeatureHealthObservation {
  key: string;
  name: string;
  status: FeatureHealthStatus;
  reason: string;
}

export interface FeatureAttentionSignal {
  dedupKey: string;
  key: string;
  severity: "high" | "medium";
  title: string;
  whyNow: string;
  /** ISO time since which the feature has been broken. */
  activityAt: string;
  status: FeatureHealthStatus;
}

interface BrokenEntry {
  since: number;
  name: string;
  status: FeatureHealthStatus;
  reason: string;
}

const broken = new Map<string, BrokenEntry>();

/** Feed one health pass. A feature that is no longer broken loses its clock. */
export function observeFeatureHealth(observations: readonly FeatureHealthObservation[], now: Date = new Date()): void {
  const seen = new Set<string>();
  for (const observation of observations) {
    seen.add(observation.key);
    if (!isFeatureBroken(observation.status)) {
      broken.delete(observation.key);
      continue;
    }
    const existing = broken.get(observation.key);
    broken.set(observation.key, {
      since: existing ? existing.since : now.getTime(),
      name: observation.name,
      status: observation.status,
      reason: observation.reason,
    });
  }
  // A feature that left the registry (or was not part of this pass) cannot stay broken.
  for (const key of [...broken.keys()]) if (!seen.has(key)) broken.delete(key);
}

/** ISO time since which a feature has been broken, or null. */
export function featureBrokenSince(key: string): string | null {
  const entry = broken.get(key);
  return entry ? new Date(entry.since).toISOString() : null;
}

function minutes(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

/** The cards the attention feed shows right now: broken for at least 30 minutes. */
export function readFeatureAttentionSignals(now: Date = new Date()): FeatureAttentionSignal[] {
  const signals: FeatureAttentionSignal[] = [];
  for (const [key, entry] of broken) {
    const age = now.getTime() - entry.since;
    if (age < FEATURE_ATTENTION_AFTER_MS) continue;
    signals.push({
      dedupKey: `${FEATURE_ATTENTION_DEDUP_PREFIX}${key}`,
      key,
      severity: entry.status === "failing" ? "high" : "medium",
      title: `${entry.name}: ${entry.status}`,
      whyNow: `${entry.name} is enabled but has been ${entry.status} for ${minutes(age)} minutes: ${entry.reason}`,
      activityAt: new Date(entry.since).toISOString(),
      status: entry.status,
    });
  }
  return signals.sort((a, b) => a.key.localeCompare(b.key));
}

/** Test helper: forget every clock. */
export function resetFeatureAttention(): void {
  broken.clear();
}
