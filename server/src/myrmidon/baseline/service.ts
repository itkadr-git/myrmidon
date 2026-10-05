// server/src/myrmidon/baseline/service.ts
//
// myrmidon(1.6-BASELINE): assembles the API answer from the query slices and
// the pure math. The response shape is the one fixed in the BASELINE design
// note and is additive-only from here on.

import type { Db } from "@paperclipai/db";
import { eq, desc } from "drizzle-orm";
import { badRequest } from "../../errors.js";
import {
  type BaselineGroupMetrics,
  type BaselineMetrics,
  type BaselineWindow,
  computeBaselineMetrics as computeGroups,
} from "./metrics.js";
import {
  type BaselineCostSource,
  detectCostSource,
  loadBlockers,
  loadCompletedTasks,
  loadCosts,
  loadRoles,
  loadRuns,
  loadTransitions,
} from "./queries.js";
import { baselineMetricSnapshots } from "@paperclipai/db";

export interface BaselineMetricsResponse {
  window: { from: string; to: string };
  generatedAt: string;
  source: { statusLog: string; costs: BaselineCostSource };
  byProject: BaselineGroupMetrics[];
  byRole: BaselineGroupMetrics[];
}

// myrmidon(1.6.2-BASELINE-C): comparing the current window against a frozen
// baseline snapshot. Differences are computed per group — for every key
// present in both the current and the baseline `byProject` maps, and the same
// for `byRole` — so a task is never counted twice (once under its project and
// once under its role) and the UI can answer "did this project / role get
// better or worse", which is the point of the comparison.

/** One scalar delta: absolute change plus percentage, `null` when the
 *  baseline value is 0 (a 0 -> x change is a real change, not "0%"). */
export interface BaselineDifference {
  absolute: number;
  percentage: number | null;
}

/** All scalar deltas for one group. `timeInReviewHours` has no p90 in the
 *  BASELINE contract, so there is no reviewTimeP90 here at all. */
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
  current: BaselineMetricsResponse;
  baseline: BaselineMetricsResponse | null;
  /** Per-key deltas. A key appears only when it exists on both sides. */
  differences: {
    byProject: Record<string, BaselineGroupDifferences>;
    byRole: Record<string, BaselineGroupDifferences>;
  } | null;
}

function parseDate(value: unknown, field: string): Date {
  if (typeof value !== "string" || value.length === 0) {
    throw badRequest(`'${field}' is required`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw badRequest(`invalid '${field}' date`);
  }
  return date;
}

/** Reads and validates the required `from`/`to` query parameters. */
export function parseBaselineWindow(query: Record<string, unknown>): BaselineWindow {
  const from = parseDate(query.from, "from");
  const to = parseDate(query.to, "to");
  if (from.getTime() > to.getTime()) {
    throw badRequest("'from' must not be after 'to'");
  }
  return { from, to };
}

/** Computes the full metrics answer for one company over one window. */
export async function computeBaselineMetrics(
  db: Db,
  companyId: string,
  window: BaselineWindow,
  now: Date,
): Promise<BaselineMetricsResponse> {
  const source = await detectCostSource(db, companyId, window);
  const tasks = await loadCompletedTasks(db, companyId, window);

  const taskIds = tasks.map((task) => task.id);
  const agentIds = [
    ...new Set(tasks.map((task) => task.assigneeAgentId).filter((id): id is string => Boolean(id))),
  ];

  const [transitions, runs, costs, blockers, roles] = await Promise.all([
    loadTransitions(db, companyId, taskIds),
    loadRuns(db, companyId, taskIds, window),
    loadCosts(db, companyId, taskIds, window, source),
    loadBlockers(db, companyId, taskIds),
    loadRoles(db, companyId, agentIds),
  ]);

  const metrics: BaselineMetrics = computeGroups(
    { tasks, transitions, runs, costs, blockers, roles },
    window,
  );

  return {
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    generatedAt: now.toISOString(),
    source: { statusLog: "activity_log", costs: source },
    byProject: metrics.byProject,
    byRole: metrics.byRole,
  };
}

/**
 * Retrieves the most recent baseline snapshot for a company
 */
export async function getLatestBaselineSnapshot(
  db: Db,
  companyId: string,
): Promise<BaselineMetricsResponse | null> {
  const snapshots = await db
    .select()
    .from(baselineMetricSnapshots)
    .where(eq(baselineMetricSnapshots.companyId, companyId))
    .orderBy(desc(baselineMetricSnapshots.generatedAt))
    .limit(1);

  if (snapshots.length === 0) {
    return null;
  }

  // The payload contains the full BaselineMetricsResponse from when the snapshot was taken
  return snapshots[0].payload as unknown as BaselineMetricsResponse;
}

/**
 * Compares current metrics with a baseline snapshot, per project and per
 * role. Each difference is computed against the group with the same key on
 * the baseline side; groups that exist on only one side are omitted from the
 * differences (there is nothing to compare them against, and the raw values
 * are still in `current`/`baseline`).
 */
export function compareWithBaseline(
  current: BaselineMetricsResponse,
  baseline: BaselineMetricsResponse | null,
): BaselineComparisonResult {
  if (!baseline) {
    return { current, baseline: null, differences: null };
  }

  return {
    current,
    baseline,
    differences: {
      byProject: diffGroups(current.byProject, baseline.byProject),
      byRole: diffGroups(current.byRole, baseline.byRole),
    },
  };
}

function diffGroups(
  current: BaselineGroupMetrics[],
  baseline: BaselineGroupMetrics[],
): Record<string, BaselineGroupDifferences> {
  const baselineByKey = new Map(baseline.map((group) => [groupKey(group.key), group]));
  const differences: Record<string, BaselineGroupDifferences> = {};
  for (const group of current) {
    const base = baselineByKey.get(groupKey(group.key));
    if (!base) continue;
    differences[groupKey(group.key)] = diffGroup(group, base);
  }
  return differences;
}

/** `key` is the project id or `null`; records can't key on `null`. */
function groupKey(key: string | null): string {
  return key ?? "";
}

function diffGroup(current: BaselineGroupMetrics, baseline: BaselineGroupMetrics): BaselineGroupDifferences {
  return {
    tasksCompleted: calculateDifference(current.tasksCompleted, baseline.tasksCompleted),
    cycleTimeMean: calculateDifference(current.cycleTimeHours.mean, baseline.cycleTimeHours.mean),
    cycleTimeMedian: calculateDifference(current.cycleTimeHours.median, baseline.cycleTimeHours.median),
    cycleTimeP90: calculateDifference(current.cycleTimeHours.p90, baseline.cycleTimeHours.p90),
    reviewTimeMean: calculateDifference(current.timeInReviewHours.mean, baseline.timeInReviewHours.mean),
    reviewTimeMedian: calculateDifference(current.timeInReviewHours.median, baseline.timeInReviewHours.median),
    returnRate: calculateDifference(current.returnRate.rate, baseline.returnRate.rate),
    blockedTotal: calculateDifference(current.blockedHours.total, baseline.blockedHours.total),
    blockedMean: calculateDifference(current.blockedHours.mean, baseline.blockedHours.mean),
    runsPerTask: calculateDifference(current.runsPerTask.mean, baseline.runsPerTask.mean),
    costPerTask: calculateDifference(current.costPerTask.meanCents, baseline.costPerTask.meanCents),
  };
}

/**
 * Calculates the absolute and percentage difference between two values.
 * `percentage` is `null` when the baseline value is 0: a change from 0 is
 * real, but it has no meaningful percentage (and it is not "0%").
 */
function calculateDifference(current: number, baseline: number): BaselineDifference {
  const absolute = current - baseline;
  const percentage = baseline !== 0 ? (absolute / baseline) * 100 : null;
  return { absolute, percentage };
}