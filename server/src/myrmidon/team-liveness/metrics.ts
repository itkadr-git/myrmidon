// myrmidon(TEAM-LIVENESS-METRICS): the 24-hour counters the health page shows.
//
// The three automatic behaviours already count their own work, each in the
// place it writes anyway:
//  - auto-resume appends one activity-log row per attempt, so
//    `autoResumeMetrics` counts the resumed agents and the agents the board
//    gave up on;
//  - progress-based run liveness stamps its own error code on every run it
//    interrupts, so `countRunStallInterrupts` counts the stalled runs;
//  - every wake the board creates is a row in `agent_wakeup_requests`, so the
//    wakes are a count over `requested_at`.
//
// Nothing changes in the writers: this module only reads the three sources for
// one company over one window, so the health card and the Prometheus endpoint
// cannot drift from the behaviour they describe.

import { and, count, eq, gte, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, type Db } from "@myrmidon/db";
import { autoResumeMetrics } from "../auto-resume.js";
import { countRunStallInterrupts } from "../run-stall/metrics.js";

/** The window the health card reports: the last day. */
export const TEAM_LIVENESS_METRIC_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface TeamLivenessMetrics {
  companyId: string;
  /** Window actually used, so a caller that asks for another one is not misread. */
  windowHours: number;
  from: string;
  to: string;
  /** Agents the board resumed out of `error` on its own. */
  autoResumes: number;
  /** Agents whose resume attempts ran out — these need a human look. */
  autoResumeExhaustions: number;
  /** Wakes the board created for this company, whatever the source. */
  wakes: number;
  /** Runs progress-based run liveness interrupted. */
  stalledRuns: number;
  /** Successful runs whose only durable issue evidence was an agent comment. */
  emptyRunsByAgent: Array<{ agentId: string; count: number }>;
}

/** How many wake requests the company saw since the given instant. */
export async function countWakesSince(db: Db, companyId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, companyId),
        gte(agentWakeupRequests.requestedAt, since),
      ),
    );
  return Number(row?.total ?? 0);
}

export async function countEmptyRunsByAgent(
  db: Db,
  companyId: string,
  since: Date,
): Promise<Array<{ agentId: string; count: number }>> {
  const rows = await db
    .select({ agentId: heartbeatRuns.agentId, total: count() })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.status, "succeeded"),
        gte(sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.updatedAt})`, since.toISOString()),
        sql`${heartbeatRuns.livenessState} in ('empty_response', 'plan_only')`,
        sql`${heartbeatRuns.livenessReason} ilike 'Run succeeded without useful output%'`,
      ),
    )
    .groupBy(heartbeatRuns.agentId);
  return rows.map((row) => ({ agentId: row.agentId, count: Number(row.total) }));
}

/**
 * The four numbers of the health card, for one company and one window. The
 * three reads run together: the card is a summary and each source is
 * independent of the others.
 */
export async function readTeamLivenessMetrics(
  db: Db,
  companyId: string,
  now: Date = new Date(),
  windowMs: number = TEAM_LIVENESS_METRIC_WINDOW_MS,
): Promise<TeamLivenessMetrics> {
  const from = new Date(now.getTime() - windowMs);
  const [resumes, wakes, stalledRuns, emptyRunsByAgent] = await Promise.all([
    autoResumeMetrics(db, companyId, from),
    countWakesSince(db, companyId, from),
    countRunStallInterrupts(db, { companyId, since: from }),
    countEmptyRunsByAgent(db, companyId, from),
  ]);
  return {
    companyId,
    windowHours: Math.round(windowMs / 3_600_000),
    from: from.toISOString(),
    to: now.toISOString(),
    autoResumes: resumes.autoResumes,
    autoResumeExhaustions: resumes.exhaustions,
    wakes,
    stalledRuns,
    emptyRunsByAgent,
  };
}