// server/src/myrmidon/swarm-claim/effective-pheromone.ts
//
// myrmidon(1.6.5 F-27 PHEROMONE, architect rework 09.10): the SQL twin of
// `effectivePheromone` (packages/shared, design §2.3).
//
// The queue, the idle pass and the supervisor view all rank tasks by the
// *effective* strength — base strength plus aging minus the evaporation
// penalty — and the inputs must come from SQL, not a second read per row.
// This file is the single place that knows the SQL shape of both terms, so
// the three consumers cannot disagree with each other (or with the shared
// helper) about what a task ranks with.

import { sql, type SQL } from "drizzle-orm";
import { issues } from "@paperclipai/db";
import type { PheromoneDynamicsSettings } from "@paperclipai/shared";

/**
 * The run statuses that evaporate pheromone (design §2.3: a run that ended
 * failed/blocked/needs-followup/timed-out without the task changing). The
 * run store has one terminal-status enum; the failure half of it is exactly
 * this list — `cancelled` is an operator action, not a failure of the run.
 */
export const PHEROMONE_EVAPORATING_RUN_STATUSES = [
  "failed",
  "blocked",
  "needs_followup",
  "timed_out",
] as const;

/**
 * SQL twin of the evaporation count: runs of the task that ended in an
 * evaporating status with no task change after them. "No change after" reads
 * the task's own activity clock (`greatest(updated_at, last_activity_at)`) —
 * any edit or comment after the run finished lifts the penalty, which is
 * exactly the acceptance test "обновление задачи снимает штраф".
 *
 * Runs attach to their task by `native_issue_id`, else by the context
 * snapshot's `issueId` (the same pairing the legacy-terminal index uses).
 */
export function failedRunsSinceLastChangeSql(): SQL<number> {
  return sql<number>`coalesce((
    select count(*)::int
    from heartbeat_runs hr
    where hr.company_id = ${issues.companyId}
      and (
        hr.native_issue_id = ${issues.id}
        or (hr.native_issue_id is null and hr.context_snapshot ->> 'issueId' = ${issues.id}::text)
      )
      and hr.status in ('failed', 'blocked', 'needs_followup', 'timed_out')
      and hr.finished_at is not null
      and hr.finished_at > greatest(${issues.updatedAt}, ${issues.lastActivityAt})
  ), 0)`;
}

/**
 * SQL twin of `effectivePheromone` over the outer `issues` row. The dynamics
 * are inlined as literals (they come from the company's swarm settings, not
 * from user input); the comparison the callers do with it is an ORDER BY.
 *
 *   eff = pheromone_strength
 *       + least(agingCap, floor(hoursWaiting / agingStepHours) * agingStep)
 *       - failPenalty * failedRunsSinceLastChange
 * clamped at 0, where hoursWaiting measures from the queue entry
 * (`created_at`, the same column `queuedAt` reads).
 */
export function effectivePheromoneSql(
  dynamics: PheromoneDynamicsSettings,
  now: Date = new Date(),
): SQL<number> {
  const agingStepHours = Math.max(0, Math.floor(dynamics.agingStepHours));
  const agingStep = Math.max(0, Math.floor(dynamics.agingStep));
  const agingCap = Math.max(0, Math.floor(dynamics.agingCap));
  const failPenalty = Math.max(0, Math.floor(dynamics.failPenalty));
  const failedRuns = failedRunsSinceLastChangeSql();
  if (agingStepHours <= 0 || agingStep <= 0) {
    return sql<number>`greatest(0,
      coalesce(${issues.pheromoneStrength}, 0)
      - ${failPenalty} * ${failedRuns}
    )`;
  }
  return sql<number>`greatest(0,
    coalesce(${issues.pheromoneStrength}, 0)
    + least(
        ${agingCap},
        floor(extract(epoch from (${now.toISOString()}::timestamptz - ${issues.createdAt})) / 3600 / ${agingStepHours})::int * ${agingStep}
      )
    - ${failPenalty} * ${failedRuns}
  )`;
}
