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
import { DEFAULT_PHEROMONE_DYNAMICS, type PheromoneDynamicsSettings } from "@paperclipai/shared";

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

/** The activity rows that are per-user bookkeeping, not a change to the task. */
const NON_CHANGE_ISSUE_ACTIONS = [
  "issue.read_marked",
  "issue.read_unmarked",
  "issue.inbox_archived",
  "issue.inbox_unarchived",
] as const;

/** How the evaporation count reaches the outer issue row (a drizzle table or a raw alias). */
export interface PheromoneIssueRefs {
  companyId: SQL;
  id: SQL;
}

/**
 * SQL twin of the evaporation count: runs of the task that ended in an
 * evaporating status with no task change after them.
 *
 * "No change after" is NOT read from `issues.updated_at` / `last_activity_at`
 * (review #1047 п.1): the run's own cleanup (`releaseIssueExecutionAndPromote`
 * -> `wakeQueue.releaseIssueExecution`) writes `updated_at = finishedAt` on the
 * task, and the migration-0355 trigger lifts `last_activity_at` with it, so
 * the penalty would be wiped by the run that earned it. The marker is the
 * task's own change trail instead, which the release does not write:
 *   - a comment on the task that the failed run did not write itself, or
 *   - an audit row of the task (entity_type = 'issue') written by a person or
 *     an agent (not the `system` actor of the sweeps and the release) outside
 *     the failed run, other than the per-user read/inbox bookkeeping,
 * created strictly after the run finished. Any such row lifts the penalty,
 * which is the acceptance test "обновление задачи снимает штраф".
 * Not covered: a blocker closed by the system (no person/agent row) — the
 * penalty then stays until the next edit or comment.
 *
 * Runs attach to their task by `native_issue_id`, else by the context
 * snapshot's `issueId` (the same pairing the legacy-terminal index uses).
 */
export function failedRunsSinceLastChangeFor(refs: PheromoneIssueRefs): SQL<number> {
  const bookkeeping = sql.join(
    NON_CHANGE_ISSUE_ACTIONS.map((action) => sql`${action}`),
    sql`, `,
  );
  return sql<number>`coalesce((
    select count(*)::int
    from heartbeat_runs hr
    where hr.company_id = ${refs.companyId}
      and (
        hr.native_issue_id = ${refs.id}
        or (hr.native_issue_id is null and hr.context_snapshot ->> 'issueId' = ${refs.id}::text)
      )
      and hr.status in ('failed', 'blocked', 'needs_followup', 'timed_out')
      and hr.finished_at is not null
      and not exists (
        select 1 from issue_comments ic
        where ic.issue_id = ${refs.id}
          and ic.deleted_at is null
          and ic.created_at > hr.finished_at
          and ic.created_by_run_id is distinct from hr.id
      )
      and not exists (
        select 1 from activity_log al
        where al.company_id = hr.company_id
          and al.entity_type = 'issue'
          and al.entity_id = ${refs.id}::text
          and al.created_at > hr.finished_at
          and al.actor_type <> 'system'
          and al.run_id is distinct from hr.id
          and al.action not in (${bookkeeping})
      )
  ), 0)`;
}

/** The evaporation count over the drizzle `issues` table (queue reads). */
export function failedRunsSinceLastChangeSql(): SQL<number> {
  return failedRunsSinceLastChangeFor({ companyId: sql`${issues.companyId}`, id: sql`${issues.id}` });
}

/** A validated integer literal: the dynamics are settings, never user text. */
function intLiteral(value: number, fallback = 0): SQL {
  const n = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
  return sql.raw(String(n));
}

/**
 * SQL twin of `effectivePheromone` over the drizzle `issues` row, with the
 * evaporation count supplied by the caller (the queue reads, the supervisor
 * view's raw alias).
 *
 *   eff = pheromone_strength
 *       + least(agingCap, floor(hoursWaiting / agingStepHours) * agingStep)
 *       - failPenalty * failedRunsSinceLastChange
 * clamped at 0, where hoursWaiting measures from the queue entry
 * (`created_at`, the same column `queuedAt` reads).
 */
export function effectivePheromoneSql(
  dynamics: PheromoneDynamicsSettings = DEFAULT_PHEROMONE_DYNAMICS,
  now: Date = new Date(),
): SQL<number> {
  const failPenalty = intLiteral(dynamics.failPenalty);
  const failedRuns = failedRunsSinceLastChangeSql();
  const stepHours = Math.max(0, Math.floor(dynamics.agingStepHours));
  const step = Math.max(0, Math.floor(dynamics.agingStep));
  if (!(stepHours > 0) || !(step > 0)) {
    return sql<number>`greatest(0, coalesce(${issues.pheromoneStrength}, 0) - ${failPenalty} * ${failedRuns})`;
  }
  return sql<number>`greatest(0,
    coalesce(${issues.pheromoneStrength}, 0)
    + least(
        ${intLiteral(dynamics.agingCap)},
        (floor(greatest(0, extract(epoch from (${now.toISOString()}::timestamptz - ${issues.createdAt}))) / 3600 / ${intLiteral(stepHours)}))::int * ${intLiteral(step)}
      )
    - ${failPenalty} * ${failedRuns}
  )`;
}

export interface SwarmQueueOrderOptions {
  dynamics?: PheromoneDynamicsSettings;
  /** Default true, like `orderSwarmQueueCandidates`. */
  p0Preemption?: boolean;
  now?: Date;
}

/**
 * The ORDER BY of every swarm queue read — the SQL twin of
 * `orderSwarmQueueCandidates` (review #1047 п.2). The candidate list is cut at
 * a LIMIT, so ordering by `created_at` in SQL and by strength only in JS meant
 * a fresh, strong task behind the oldest 200 never became a candidate. Same
 * keys, same direction: priority rank (when P0 preemption is on), effective
 * strength descending, queue entry ascending, id as the stable last key.
 */
export function swarmQueueOrderBy(options: SwarmQueueOrderOptions = {}): SQL[] {
  const items: SQL[] = [];
  if (options.p0Preemption ?? true) {
    items.push(sql`(case ${issues.priority}
      when 'critical' then 0
      when 'high' then 1
      when 'medium' then 2
      when 'low' then 3
      else 4 end) asc`);
  }
  items.push(sql`${effectivePheromoneSql(options.dynamics, options.now)} desc`);
  items.push(sql`${issues.createdAt} asc`);
  items.push(sql`${issues.id} asc`);
  return items;
}
