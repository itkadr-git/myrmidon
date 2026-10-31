export const DEVFLOW_HEALTH_SETTINGS_KEY = "devflowHealth" as const;
export const DEFAULT_DEVFLOW_THRESHOLDS_MS = {
  engineerIdleMs: 60 * 60_000,
  reviewQueueAgeMs: 24 * 60 * 60_000,
  redCiMs: 60 * 60_000,
  codeTasksOnNoncodingRolesMs: 30 * 60_000,
  staleMarkerMs: 60 * 60_000,
  stalledMergeMs: 60 * 60_000,
  stalledRouterMs: 60 * 60_000,
  approvedNotMergedMs: 2 * 60 * 60_000,
  noMergesMs: 6 * 60 * 60_000,
} as const;

export type DevflowMetric = keyof typeof DEFAULT_DEVFLOW_THRESHOLDS_MS;
export type DevflowThresholdsMs = Record<DevflowMetric, number>;
export type DevflowDurationsMs = Partial<Record<DevflowMetric, number>>;
export type DevflowAlert = { metric: DevflowMetric; durationMs: number; thresholdMs: number };

export interface DevflowHealthSettings {
  engineerIdleMs?: number;
  reviewQueueAgeMs?: number;
  redCiMs?: number;
  codeTasksOnNoncodingRolesMs?: number;
  staleMarkerMs?: number;
  approvalMarkerMs?: number;
  stalledMergeMs?: number;
  autoMergeMs?: number;
  stalledRouterMs?: number;
  reviewRouterMs?: number;
  approvedNotMergedMs?: number;
  noMergesMs?: number;
}

export function readDevflowThresholds(settings: unknown): DevflowThresholdsMs {
  const value = settings && typeof settings === "object" ? (settings as DevflowHealthSettings) : {};
  const envApprovedNotMerged = process.env.MYRMIDON_DEVFLOW_APPROVED_NOT_MERGED_MS
    ? Number(process.env.MYRMIDON_DEVFLOW_APPROVED_NOT_MERGED_MS)
    : undefined;
  const envNoMerges = process.env.MYRMIDON_DEVFLOW_NO_MERGES_MS
    ? Number(process.env.MYRMIDON_DEVFLOW_NO_MERGES_MS)
    : undefined;

  return {
    engineerIdleMs: validThreshold(value.engineerIdleMs, DEFAULT_DEVFLOW_THRESHOLDS_MS.engineerIdleMs),
    reviewQueueAgeMs: validThreshold(value.reviewQueueAgeMs, DEFAULT_DEVFLOW_THRESHOLDS_MS.reviewQueueAgeMs),
    redCiMs: validThreshold(value.redCiMs, DEFAULT_DEVFLOW_THRESHOLDS_MS.redCiMs),
    codeTasksOnNoncodingRolesMs: validThreshold(value.codeTasksOnNoncodingRolesMs, DEFAULT_DEVFLOW_THRESHOLDS_MS.codeTasksOnNoncodingRolesMs),
    staleMarkerMs: validThreshold(value.staleMarkerMs ?? value.approvalMarkerMs, DEFAULT_DEVFLOW_THRESHOLDS_MS.staleMarkerMs),
    stalledMergeMs: validThreshold(value.stalledMergeMs ?? value.autoMergeMs, DEFAULT_DEVFLOW_THRESHOLDS_MS.stalledMergeMs),
    stalledRouterMs: validThreshold(value.stalledRouterMs ?? value.reviewRouterMs, DEFAULT_DEVFLOW_THRESHOLDS_MS.stalledRouterMs),
    approvedNotMergedMs: validThreshold(
      value.approvedNotMergedMs ?? envApprovedNotMerged,
      DEFAULT_DEVFLOW_THRESHOLDS_MS.approvedNotMergedMs,
    ),
    noMergesMs: validThreshold(
      value.noMergesMs ?? envNoMerges,
      DEFAULT_DEVFLOW_THRESHOLDS_MS.noMergesMs,
    ),
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
  staleMarkerSince?: Date | string | null;
  stalledMergeSince?: Date | string | null;
  stalledRouterSince?: Date | string | null;
  approvedNotMergedSince?: Date | string | null;
  noMergesSince?: Date | string | null;
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
    staleMarkerMs: age(snapshot.staleMarkerSince),
    stalledMergeMs: age(snapshot.stalledMergeSince),
    stalledRouterMs: age(snapshot.stalledRouterSince),
    approvedNotMergedMs: age(snapshot.approvedNotMergedSince),
    noMergesMs: age(snapshot.noMergesSince),
  };
}
