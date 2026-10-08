// myrmidon(1.6-BASELINE part B): API client for the "Quality" page — delivery
// quality metrics over a window, split by project and by agent role.
// Server side: GET /api/myrmidon/companies/:id/baseline/metrics (part A,
// eng-4 — the JSON contract is frozen in the design note; until part A
// merges, the tests mock this client's return shape).
// Also includes comparison API: GET /api/myrmidon/companies/:id/baseline/compare

import { api } from "@/api/client";

export interface BaselineWindow {
  from: string;
  to: string;
}

export interface BaselineSource {
  statusLog: string;
  costs: "litellm_cost_events" | "cost_events" | "none";
}

export interface BaselineCycleTimeHours {
  mean: number;
  median: number;
  p90: number;
}

export interface BaselineTimeInReviewHours {
  mean: number;
  median: number;
}

export interface BaselineReturnRate {
  enteredReview: number;
  returned: number;
  rate: number;
}

export interface BaselineTopCause {
  cause: string;
  hours: number;
}

export interface BaselineBlockedHours {
  total: number;
  mean: number;
  topCauses: BaselineTopCause[];
}

export interface BaselineRunsPerTask {
  total: number;
  mean: number;
}

export interface BaselineCostPerTask {
  totalCents: number;
  meanCents: number;
}

/** One row of byProject (key = project id or null) or byRole (key = role). */
export interface BaselineMetricRow {
  key: string | null;
  tasksCompleted: number;
  cycleTimeHours: BaselineCycleTimeHours;
  timeInReviewHours: BaselineTimeInReviewHours;
  returnRate: BaselineReturnRate;
  blockedHours: BaselineBlockedHours;
  runsPerTask: BaselineRunsPerTask;
  costPerTask: BaselineCostPerTask;
}

export interface BaselineMetricsReport {
  window: BaselineWindow;
  generatedAt: string;
  source: BaselineSource;
  byProject: BaselineMetricRow[];
  byRole: BaselineMetricRow[];
}

export interface BaselineDifference {
  absolute: number;
  /** null when the baseline value is 0: a change from 0 is real, not "0%". */
  percentage: number | null;
}

/** Per-group deltas. timeInReviewHours has no p90 in the BASELINE contract,
 *  so there is no reviewTimeP90 here at all. */
export interface BaselineGroupDifferences {
  tasksCompleted: BaselineDifference;
  cycleTimeMean: BaselineDifference;
  cycleTimeMedian: BaselineDifference;
  cycleTimeP90: BaselineDifference;
  reviewTimeMean: BaselineDifference;
  reviewTimeMedian: BaselineDifference;
  returnRate: BaselineDifference;
  blockedTotal: BaselineDifference;
  blockedMean: BaselineDifference;
  runsPerTask: BaselineDifference;
  costPerTask: BaselineDifference;
}

export interface BaselineComparisonResult {
  current: BaselineMetricsReport;
  baseline: BaselineMetricsReport | null;
  /** Per-key deltas for groups present on both sides; a null project key is
   *  the "" record key. null when no baseline snapshot exists. */
  differences: {
    byProject: Record<string, BaselineGroupDifferences>;
    byRole: Record<string, BaselineGroupDifferences>;
  } | null;
}

const base = (companyId: string) =>
  `/myrmidon/companies/${encodeURIComponent(companyId)}/baseline/metrics`;

const compareBase = (companyId: string) =>
  `/myrmidon/companies/${encodeURIComponent(companyId)}/baseline/compare`;

export const baselineApi = {
  metrics: (companyId: string, from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    return api.get<BaselineMetricsReport>(`${base(companyId)}${qs ? `?${qs}` : ""}`);
  },
  compare: (companyId: string, from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    return api.get<BaselineComparisonResult>(`${compareBase(companyId)}${qs ? `?${qs}` : ""}`);
  },
};

export const baselineMetricsKey = (companyId: string, from?: string, to?: string) =>
  ["myrmidon", "baseline", "metrics", companyId, from ?? null, to ?? null] as const;

export const baselineCompareKey = (companyId: string, from?: string, to?: string) =>
  ["myrmidon", "baseline", "compare", companyId, from ?? null, to ?? null] as const;

/** 503 body while the server-side part is not enabled: "not enabled" style. */
export function isNotEnabledError(err: unknown): boolean {
  return err instanceof Error && /not enabled/i.test(err.message);
}
