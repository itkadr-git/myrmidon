// server/src/myrmidon/swarm-claim/cooling.ts
//
// myrmidon(1.6.5 OPE-6608, review item 1): the cooling of a task (design §4.3).
//
// A task whose last runs ended without moving it (failed / blocked / needs
// follow-up / timed out, or a success that did not advance a task that stayed in
// `todo`) must not be matched or woken again at once: "finish -> wake -> run ->
// finish" on an assigned `todo` task is the loop that cost 100 runs and 246 M
// tokens in a week. The wait doubles with every such run in a row
// (`base * 2^(n-1)`, 30 min by default, capped at 24 h), and any change of the
// task by somebody else (a person, an agent, a comment) lifts it at once.
//
// This is the board-side reading the matcher needs today; T5 (OPE-6613) brings
// the same rule to the wake layer and may replace it through the matcher's
// `isIssueCoolingDown` port. Until then the matcher uses this one, so the port is
// never a stub that answers `false`.

import { and, desc, eq, gt, isNull, ne, notInArray, inArray, or, sql } from "drizzle-orm";
import { activityLog, heartbeatRuns, type Db } from "@paperclipai/db";

/** Default base of the cooldown, minutes (design §4.3). */
export const SWARM_COOLDOWN_BASE_MIN = 30;
/** Upper bound of the cooldown, minutes (24 h). */
export const SWARM_COOLDOWN_MAX_MIN = 24 * 60;

/** How many of the newest finished runs of a task feed the streak. */
const COOLING_RUN_SAMPLE = 12;

/** Liveness verdicts of a run that did not move its task. */
const NO_MOVEMENT_LIVENESS = new Set(["blocked", "failed", "needs_followup"]);
/** Liveness verdicts of a run that did move it. */
const MOVEMENT_LIVENESS = new Set(["advanced", "completed"]);

/** One finished run, as much of it as the rule reads. */
export interface SwarmCoolingRun {
  status: string;
  livenessState: string | null;
  endedAt: Date;
}

/** True when the run ended without moving its task. */
export function runLeftTaskUnmoved(run: Pick<SwarmCoolingRun, "status" | "livenessState">): boolean {
  if (run.status === "failed" || run.status === "timed_out") return true;
  if (run.livenessState && NO_MOVEMENT_LIVENESS.has(run.livenessState)) return true;
  // A success that was not verdicted "advanced"/"completed". A success with no
  // verdict at all is unknown, not unmoved: it does not start a cooldown.
  if (run.status === "succeeded" && run.livenessState && !MOVEMENT_LIVENESS.has(run.livenessState)) {
    return true;
  }
  return false;
}

/** The number of unmoved runs in a row, newest first. */
export function unmovedStreak(runsNewestFirst: readonly SwarmCoolingRun[]): number {
  let streak = 0;
  for (const run of runsNewestFirst) {
    if (!runLeftTaskUnmoved(run)) break;
    streak += 1;
  }
  return streak;
}

/** `base * 2^(n-1)` minutes, capped; 0 for a task with no unmoved run. */
export function cooldownMs(
  streak: number,
  options: { baseMin?: number; maxMin?: number } = {},
): number {
  if (streak <= 0) return 0;
  const baseMin = options.baseMin ?? SWARM_COOLDOWN_BASE_MIN;
  const maxMin = options.maxMin ?? SWARM_COOLDOWN_MAX_MIN;
  const minutes = Math.min(baseMin * 2 ** Math.min(streak - 1, 30), maxMin);
  return minutes * 60_000;
}

/**
 * True while the task waits out its cooldown. Read from the finished runs of the
 * task and the audit log, nothing is stored: the cooling cannot get stuck, and
 * a change of the task lifts it on the very next read.
 */
export async function isIssueCoolingDown(
  db: Db,
  issueId: string,
  now: Date,
  options: { baseMin?: number; maxMin?: number } = {},
): Promise<boolean> {
  const rows = await db
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      livenessState: heartbeatRuns.livenessState,
      finishedAt: heartbeatRuns.finishedAt,
      createdAt: heartbeatRuns.createdAt,
    })
    .from(heartbeatRuns)
    .where(
      and(
        // A cancelled run says nothing about the task and is not read at all.
        inArray(heartbeatRuns.status, ["succeeded", "failed", "timed_out"]),
        or(
          eq(heartbeatRuns.contextIssueId, issueId),
          and(
            isNull(heartbeatRuns.contextIssueId),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          ),
        ),
      ),
    )
    .orderBy(desc(sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.createdAt})`))
    .limit(COOLING_RUN_SAMPLE);
  if (rows.length === 0) return false;

  const runs: SwarmCoolingRun[] = rows.map((row) => ({
    status: row.status,
    livenessState: row.livenessState ?? null,
    endedAt: row.finishedAt ?? row.createdAt,
  }));
  const streak = unmovedStreak(runs);
  if (streak === 0) return false;

  const lastEndedAt = runs[0]!.endedAt;
  if (now.getTime() >= lastEndedAt.getTime() + cooldownMs(streak, options)) return false;

  // Any change of the task by somebody else after the last run lifts the
  // cooling: a comment, an edit, a re-assignment by a person. The board's own
  // writes (actor `system`: the matcher, the sweep) and the activity of the
  // runs that built the streak do not count — they are the loop, not a change.
  const streakRunIds = rows.slice(0, streak).map((row) => row.id);
  const [changed] = await db
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, issueId),
        gt(activityLog.createdAt, lastEndedAt),
        ne(activityLog.actorType, "system"),
        or(isNull(activityLog.runId), notInArray(activityLog.runId, streakRunIds)),
      ),
    )
    .limit(1);
  return !changed;
}
