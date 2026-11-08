export const PROVIDER_USAGE_METRICS = ["requests", "tokens"] as const;
export type ProviderUsageMetric = (typeof PROVIDER_USAGE_METRICS)[number];
export type ProviderUsageWindowKind = "package" | "rolling_5h" | "rolling_7d";

/** Versioned, credential-safe adapter report. No provider secrets or raw credential values. */
export interface ProviderUsageReportedEventV1 {
  schemaVersion: 1;
  companyId: string;
  eventId: string;
  ownerIssueId?: string;
  provider: string;
  credentialRef: string;
  observedAt: string;
  window: {
    kind: ProviderUsageWindowKind;
    startedAt: string;
    resetsAt: string;
    used: Partial<Record<ProviderUsageMetric, number>>;
    limit: Partial<Record<ProviderUsageMetric, number>>;
  };
}

export interface ProviderUsageWarning {
  key: string;
  companyId: string;
  provider: string;
  credentialRef: string;
  window: ProviderUsageWindowKind;
  observedAt: string;
  resetsAt: string;
  thresholdPercent: number;
  metric: ProviderUsageMetric;
  used: number;
  limit: number;
  remaining: number;
  remainingPercent: number;
  /** `usage`: the consumed share reached the threshold; `time`: the window is past the threshold share of its length. */
  trigger: "usage" | "time";
  usedPercent: number;
  elapsedPercent: number;
}

/** One human-readable line per warning; the wording follows what actually triggered it. */
export function describeProviderUsageWarning(w: Pick<ProviderUsageWarning, "provider" | "metric" | "trigger" | "usedPercent" | "elapsedPercent" | "thresholdPercent" | "used" | "limit" | "remaining" | "resetsAt">): string {
  const pct = (n: number) => `${Math.round(n)}%`;
  if (w.trigger === "usage") {
    return `${w.provider} ${w.metric}: used ${pct(w.usedPercent)} (threshold ${pct(w.thresholdPercent)}), ${w.remaining} of ${w.limit} remains before reset at ${w.resetsAt}.`;
  }
  return `${w.provider} ${w.metric}: ${pct(w.elapsedPercent)} of the window has elapsed (threshold ${pct(w.thresholdPercent)}), used ${pct(w.usedPercent)} so far; ${w.remaining} of ${w.limit} remains before reset at ${w.resetsAt}.`;
}

export interface ProviderUsageAggregate {
  provider: string;
  credentialRef: string;
  window: ProviderUsageWindowKind;
  startedAt: string;
  resetsAt: string;
  observedAt: string;
  used: Partial<Record<ProviderUsageMetric, number>>;
  limit: Partial<Record<ProviderUsageMetric, number>>;
  remaining: Partial<Record<ProviderUsageMetric, number>>;
  remainingPercent: Partial<Record<ProviderUsageMetric, number>>;
  thresholdPercent: number;
  warning: ProviderUsageWarning | null;
  ownerIssueId?: string;
}

export function evaluateProviderUsageWarning(
  event: ProviderUsageReportedEventV1,
  thresholdPercent = 80,
  companyId = "",
  now = event.observedAt,
): ProviderUsageWarning | null {
  if (!Number.isFinite(thresholdPercent) || thresholdPercent <= 0 || thresholdPercent >= 100) {
    throw new RangeError("thresholdPercent must be greater than 0 and less than 100");
  }
  if (companyId && event.companyId !== companyId) return null;
  const observed = Date.parse(event.observedAt);
  const started = Date.parse(event.window.startedAt);
  const resets = Date.parse(event.window.resetsAt);
  const current = Date.parse(now);
  if (![observed, started, resets, current].every(Number.isFinite) || started > observed || observed >= resets || current < started || current >= resets) return null;
  const elapsedPercent = (current - started) / (resets - started) * 100;
  const timeThresholdReached = elapsedPercent >= thresholdPercent;

  for (const metric of PROVIDER_USAGE_METRICS) {
    const used = event.window.used[metric];
    const limit = event.window.limit[metric];
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0) continue;
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) continue;
    const usedPercent = used / limit * 100;
    if (usedPercent < thresholdPercent && !timeThresholdReached) continue;
    const remaining = Math.max(0, limit - used);
    return {
      key: [event.companyId, event.provider, event.credentialRef, event.window.kind, event.window.startedAt, metric].join(":"),
      companyId: event.companyId,
      provider: event.provider,
      credentialRef: event.credentialRef,
      window: event.window.kind,
      observedAt: current === observed ? event.observedAt : new Date(current).toISOString(),
      resetsAt: event.window.resetsAt,
      thresholdPercent,
      metric,
      used,
      limit,
      remaining,
      remainingPercent: Math.max(0, 100 - usedPercent),
      trigger: usedPercent >= thresholdPercent ? "usage" : "time",
      usedPercent,
      elapsedPercent,
    };
  }
  return null;
}

export function aggregateProviderUsageReports(
  events: readonly ProviderUsageReportedEventV1[],
  thresholdPercent = 80,
  now?: string,
): ProviderUsageAggregate[] {
  const latest = new Map<string, ProviderUsageReportedEventV1>();
  for (const event of events) {
    if (event.schemaVersion !== 1 || !event.eventId || !event.provider || !event.credentialRef) continue;
    const key = [event.companyId, event.provider, event.credentialRef, event.window.kind, event.window.startedAt].join(":");
    const current = latest.get(key);
    if (!current || Date.parse(event.observedAt) > Date.parse(current.observedAt)) latest.set(key, event);
  }
  return [...latest.values()].filter((event) => Date.parse(event.observedAt) < Date.parse(event.window.resetsAt)).map((event) => {
    const remaining: Partial<Record<ProviderUsageMetric, number>> = {};
    const remainingPercent: Partial<Record<ProviderUsageMetric, number>> = {};
    for (const metric of PROVIDER_USAGE_METRICS) {
      const used = event.window.used[metric];
      const limit = event.window.limit[metric];
      if (typeof used !== "number" || typeof limit !== "number" || limit <= 0) continue;
      remaining[metric] = Math.max(0, limit - used);
      remainingPercent[metric] = Math.max(0, 100 - used / limit * 100);
    }
    return {
      provider: event.provider,
      credentialRef: event.credentialRef,
      window: event.window.kind,
      startedAt: event.window.startedAt,
      resetsAt: event.window.resetsAt,
      observedAt: event.observedAt,
      used: { ...event.window.used },
      limit: { ...event.window.limit },
      remaining,
      remainingPercent,
      thresholdPercent,
      warning: evaluateProviderUsageWarning(event, thresholdPercent, event.companyId, now ?? event.observedAt),
    };
  });
}
