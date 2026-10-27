import type { InferSelectModel } from "drizzle-orm";

export const DEVFLOW_HEALTH_SETTINGS_KEY = "devflowHealth" as const;
export const DEFAULT_DEVFLOW_THRESHOLDS_MS = {
  engineerIdleMs: 60 * 60_000,
  reviewQueueAgeMs: 24 * 60 * 60_000,
  redCiMs: 60 * 60_000,
} as const;

export type DevflowMetric = keyof typeof DEFAULT_DEVFLOW_THRESHOLDS_MS;
export type DevflowThresholdsMs = Record<DevflowMetric, number>;
export type DevflowDurationsMs = Partial<Record<DevflowMetric, number>>;
export type DevflowAlert = { metric: DevflowMetric; durationMs: number; thresholdMs: number };

export interface DevflowHealthSettings {
  engineerIdleMs?: number;
  reviewQueueAgeMs?: number;
  redCiMs?: number;
}

export function readDevflowThresholds(settings: unknown): DevflowThresholdsMs {
  const value = settings && typeof settings === "object" ? settings as DevflowHealthSettings : {};
  return {
    engineerIdleMs: validThreshold(value.engineerIdleMs, DEFAULT_DEVFLOW_THRESHOLDS_MS.engineerIdleMs),
    reviewQueueAgeMs: validThreshold(value.reviewQueueAgeMs, DEFAULT_DEVFLOW_THRESHOLDS_MS.reviewQueueAgeMs),
    redCiMs: validThreshold(value.redCiMs, DEFAULT_DEVFLOW_THRESHOLDS_MS.redCiMs),
  };
}

function validThreshold(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Pure threshold evaluation: no model or network call is made here. */
export function evaluateDevflowThresholds(
  durations: DevflowDurationsMs,
  settings: unknown = {},
): DevflowAlert[] {
  const thresholds = readDevflowThresholds(settings);
  return (Object.keys(thresholds) as DevflowMetric[])
    .filter((metric) => {
      const duration = durations[metric];
      return typeof duration === "number" && Number.isFinite(duration) && duration >= thresholds[metric];
    })
    .map((metric) => ({ metric, durationMs: durations[metric]!, thresholdMs: thresholds[metric] }));
}

export interface DevflowTimestampSnapshot {
  engineerLastHeartbeatAt?: Date | string | null;
  reviewEnteredAt?: Date | string | null;
  ciRedSince?: Date | string | null;
}

/** Derives persisted event ages. Missing timestamps remain absent, never zero. */
export function collectDevflowDurations(snapshot: DevflowTimestampSnapshot, now = new Date()): DevflowDurationsMs {
  const age = (at: Date | string | null | undefined): number | undefined => {
    if (!at) return undefined;
    const time = at instanceof Date ? at.getTime() : Date.parse(at);
    if (!Number.isFinite(time)) return undefined;
    return Math.max(0, now.getTime() - time);
  };
  return {
    engineerIdleMs: age(snapshot.engineerLastHeartbeatAt),
    reviewQueueAgeMs: age(snapshot.reviewEnteredAt),
    redCiMs: age(snapshot.ciRedSince),
  };
}
