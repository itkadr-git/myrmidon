// server/src/myrmidon/baseline/service.ts
//
// myrmidon(1.6-BASELINE): assembles the API answer from the query slices and
// the pure math. The response shape is the one fixed in the BASELINE design
// note and is additive-only from here on.

import type { Db } from "@paperclipai/db";
import { and, eq, desc } from "drizzle-orm";
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

// Define the structure for baseline comparison
export interface BaselineComparisonResult {
  current: BaselineMetricsResponse;
  baseline: BaselineMetricsResponse | null;
  differences: {
    cycleTimeMean: { absolute: number; percentage: number } | null;
    cycleTimeMedian: { absolute: number; percentage: number } | null;
    cycleTimeP90: { absolute: number; percentage: number } | null;
    reviewTimeMean: { absolute: number; percentage: number } | null;
    reviewTimeMedian: { absolute: number; percentage: number } | null;
    reviewTimeP90: { absolute: number; percentage: number } | null;
    returnRate: { absolute: number; percentage: number } | null;
    blockedTotal: { absolute: number; percentage: number } | null;
    blockedMean: { absolute: number; percentage: number } | null;
    runsPerTask: { absolute: number; percentage: number } | null;
    costPerTask: { absolute: number; percentage: number } | null;
    tasksCompleted: { absolute: number; percentage: number } | null;
  };
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
  return snapshots[0].payload as BaselineMetricsResponse;
}

/**
 * Compares current metrics with a baseline snapshot
 */
export function compareWithBaseline(
  current: BaselineMetricsResponse,
  baseline: BaselineMetricsResponse | null,
): BaselineComparisonResult {
  if (!baseline) {
    // If no baseline, return current metrics with null differences
    return {
      current,
      baseline: null,
      differences: {
        cycleTimeMean: null,
        cycleTimeMedian: null,
        cycleTimeP90: null,
        reviewTimeMean: null,
        reviewTimeMedian: null,
        reviewTimeP90: null,
        returnRate: null,
        blockedTotal: null,
        blockedMean: null,
        runsPerTask: null,
        costPerTask: null,
        tasksCompleted: null,
      },
    };
  }

  // Calculate aggregated metrics from all groups for both current and baseline
  const currentAggregated = aggregateMetrics(current);
  const baselineAggregated = aggregateMetrics(baseline);

  return {
    current,
    baseline,
    differences: {
      cycleTimeMean: calculateDifference(
        currentAggregated.cycleTimeMean,
        baselineAggregated.cycleTimeMean
      ),
      cycleTimeMedian: calculateDifference(
        currentAggregated.cycleTimeMedian,
        baselineAggregated.cycleTimeMedian
      ),
      cycleTimeP90: calculateDifference(
        currentAggregated.cycleTimeP90,
        baselineAggregated.cycleTimeP90
      ),
      reviewTimeMean: calculateDifference(
        currentAggregated.reviewTimeMean,
        baselineAggregated.reviewTimeMean
      ),
      reviewTimeMedian: calculateDifference(
        currentAggregated.reviewTimeMedian,
        baselineAggregated.reviewTimeMedian
      ),
      reviewTimeP90: calculateDifference(
        currentAggregated.reviewTimeP90,
        baselineAggregated.reviewTimeP90
      ),
      returnRate: calculateDifference(
        currentAggregated.returnRate,
        baselineAggregated.returnRate
      ),
      blockedTotal: calculateDifference(
        currentAggregated.blockedTotal,
        baselineAggregated.blockedTotal
      ),
      blockedMean: calculateDifference(
        currentAggregated.blockedMean,
        baselineAggregated.blockedMean
      ),
      runsPerTask: calculateDifference(
        currentAggregated.runsPerTask,
        baselineAggregated.runsPerTask
      ),
      costPerTask: calculateDifference(
        currentAggregated.costPerTask,
        baselineAggregated.costPerTask
      ),
      tasksCompleted: calculateDifference(
        currentAggregated.tasksCompleted,
        baselineAggregated.tasksCompleted
      ),
    },
  };
}

/**
 * Helper function to aggregate metrics from all groups
 */
function aggregateMetrics(response: BaselineMetricsResponse): {
  cycleTimeMean: number;
  cycleTimeMedian: number;
  cycleTimeP90: number;
  reviewTimeMean: number;
  reviewTimeMedian: number;
  reviewTimeP90: number;
  returnRate: number;
  blockedTotal: number;
  blockedMean: number;
  runsPerTask: number;
  costPerTask: number;
  tasksCompleted: number;
} {
  const allGroups = [...response.byProject, ...response.byRole];
  
  if (allGroups.length === 0) {
    // Return defaults if no groups
    return {
      cycleTimeMean: 0,
      cycleTimeMedian: 0,
      cycleTimeP90: 0,
      reviewTimeMean: 0,
      reviewTimeMedian: 0,
      reviewTimeP90: 0,
      returnRate: 0,
      blockedTotal: 0,
      blockedMean: 0,
      runsPerTask: 0,
      costPerTask: 0,
      tasksCompleted: 0,
    };
  }

  // Aggregate metrics across all groups
  const totalTasks = allGroups.reduce((sum, group) => sum + group.tasksCompleted, 0);
  
  // Weighted averages based on tasks completed in each group
  let weightedCycleTimeMean = 0;
  let weightedCycleTimeMedian = 0;
  let weightedCycleTimeP90 = 0;
  let weightedReviewTimeMean = 0;
  let weightedReviewTimeMedian = 0;
  let weightedReviewTimeP90 = 0;
  let weightedReturnRate = 0;
  let weightedRunsPerTask = 0;
  let weightedCostPerTask = 0;

  for (const group of allGroups) {
    const weight = group.tasksCompleted / totalTasks;
    
    weightedCycleTimeMean += group.cycleTimeHours.mean * weight;
    weightedCycleTimeMedian += group.cycleTimeHours.median * weight;
    weightedCycleTimeP90 += group.cycleTimeHours.p90 * weight;
    weightedReviewTimeMean += group.timeInReviewHours.mean * weight;
    weightedReviewTimeMedian += group.timeInReviewHours.median * weight;
    // timeInReviewHours does not have p90, only mean and median
    weightedReturnRate += group.returnRate.rate * weight;
    weightedRunsPerTask += group.runsPerTask.mean * weight;
    weightedCostPerTask += group.costPerTask.meanCents * weight;
  }

  const totalBlockedTotal = allGroups.reduce((sum, group) => sum + group.blockedHours.total, 0);
  const totalBlockedMean = totalTasks > 0 ? totalBlockedTotal / totalTasks : 0;

  return {
    cycleTimeMean: weightedCycleTimeMean,
    cycleTimeMedian: weightedCycleTimeMedian,
    cycleTimeP90: weightedCycleTimeP90,
    reviewTimeMean: weightedReviewTimeMean,
    reviewTimeMedian: weightedReviewTimeMedian,
    reviewTimeP90: 0, // timeInReviewHours does not have p90
    returnRate: weightedReturnRate,
    blockedTotal: totalBlockedTotal,
    blockedMean: totalBlockedMean,
    runsPerTask: weightedRunsPerTask,
    costPerTask: weightedCostPerTask,
    tasksCompleted: totalTasks,
  };
}

/**
 * Calculates the absolute and percentage difference between two values
 */
function calculateDifference(current: number, baseline: number): { absolute: number; percentage: number } {
  const absolute = current - baseline;
  const percentage = baseline !== 0 ? (absolute / baseline) * 100 : 0;
  return { absolute, percentage };
}