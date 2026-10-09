// myrmidon(1.6.5 F-26 T5): the taskless-wake gate and the cooling window.
//
// Design 1.6.5 §3.7: an automatic wake whose context names no existing task
// must never reach the adapter — it closes `skipped` with 0 tokens. §4.3: a
// task that has not moved since its last stale automatic run cools down
// exponentially instead of being woken every sweep. Both decisions live here
// so the heartbeat, the idle-pickup sweep, and the cooling list endpoint
// share one implementation.

import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  TASKLESS_BLOCKED_WAKE_REASONS,
  resolveSwarmSettings,
  swarmCoolingPeriodMs,
  type SwarmSettings,
} from "@paperclipai/shared";

export interface TasklessWakeContext {
  source: string | null | undefined;
  reason: string | null | undefined;
  issueId: string | null | undefined;
}

/**
 * True when an automatic wake must be gated for carrying no task (§3.7).
 * Manual wakes, chat wakes and every non-listed automatic reason pass
 * untouched; a listed reason passes only when it names an issue id. Whether
 * that issue actually exists is the caller's check (`tasklessReasonForWake`).
 */
export function isTasklessAutomaticWake(ctx: TasklessWakeContext): boolean {
  if (ctx.source !== "automation") return false;
  if (!ctx.reason || !TASKLESS_BLOCKED_WAKE_REASONS.has(ctx.reason)) return false;
  return !(typeof ctx.issueId === "string" && ctx.issueId.trim().length > 0);
}

/**
 * Decide the gate for one automatic wake once the db is available. Returns
 * the gate reason when the wake must be skipped (`no_task` — context names no
 * issue; `task_missing` — the named issue does not exist in this company or
 * was deleted), and `null` when the wake may proceed. Manual/user sources
 * always return `null`: a manual wake is the owner acting and passes on
 * every setting (acceptance "ручная побудка пользователя проходит всегда").
 */
export async function tasklessGateReason(
  db: Db,
  companyId: string,
  ctx: TasklessWakeContext & { manualUserWake?: boolean },
): Promise<"no_task" | "task_missing" | null> {
  if (ctx.manualUserWake) return null;
  if (ctx.source !== "automation") return null;
  if (!ctx.reason || !TASKLESS_BLOCKED_WAKE_REASONS.has(ctx.reason)) return null;
  const issueId =
    typeof ctx.issueId === "string" && ctx.issueId.trim().length > 0
      ? ctx.issueId.trim()
      : null;
  if (!issueId) return "no_task";
  const exists = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.id, issueId),
        eq(issues.companyId, companyId),
        isNull(issues.hiddenAt),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return exists ? null : "task_missing";
}

/** Last-run statuses that (with no task movement) start a cooling period. */
const COOLING_TERMINAL_STATUSES = ["succeeded", "failed", "timed_out"] as const;

/**
 * Activity actions that are real task movement (§4.3 "любое изменение задачи").
 * `issues.updatedAt` is deliberately NOT a movement signal: finishing any run
 * that held the task goes through `releaseIssueExecution`, which bumps
 * `updatedAt` after `finishedAt` unconditionally, so it would always lift the
 * window of exactly the runs the cooling exists for.
 */
const MOVEMENT_ACTIVITY_ACTIONS = [
  "issue.updated",
  "issue.comment_added",
  "issue.comment.created",
  "issue.document_updated",
  "issue.attachment_added",
  "issue.thread_interaction_answered",
  "issue.thread_interaction_accepted",
];
const HEALTHY_LIVENESS = new Set(["advanced", "completed", "followup_scheduled"]);

export interface IssueCoolingStatus {
  cooling: boolean;
  /** Consecutive stale automatic runs (>=1 when cooling). */
  staleCount: number;
  /** Minutes of the cooling window computed from the exponent (0 = not cooling). */
  cooldownMin: number;
  /** Short human-readable trigger of the window, for the T4 list. */
  reason: string | null;
  /** When the next automatic wake of this issue is allowed. */
  nextWakeAt: Date | null;
}

export const NOT_COOLING: IssueCoolingStatus = {
  cooling: false,
  staleCount: 0,
  cooldownMin: 0,
  reason: null,
  nextWakeAt: null,
};

function runIsStale(
  row: { status: string; livenessState: string | null },
  issueStatus: string,
): boolean {
  if (row.status === "failed" || row.status === "timed_out") return true;
  if (row.livenessState === "blocked" || row.livenessState === "needs_followup") return true;
  return (
    row.status === "succeeded" &&
    issueStatus === "todo" &&
    !HEALTHY_LIVENESS.has(row.livenessState ?? "")
  );
}

/**
 * Cooling evaluation for one issue (§4.3). The issue cools down when its last
 * terminal automatic run ended stale (failed / timed_out / blocked /
 * needs_followup / succeeded-without-advance while the task is still `todo`)
 * AND the task did not move after that run (a comment, or `issue.updated`-style
 * activity: status / assignee / description; never `updatedAt`). The
 * exponent is the number of consecutive stale automatic runs; the period is
 * `cooldownBaseMin * 2^(n-1)` clamped to `cooldownCeilingHours`
 * (`swarmCoolingPeriodMs`). Movement resets the window, and movement between
 * two stale runs also resets the exponent: only runs after the last movement count.
 *
 * `now` is injectable so tests pin the clock. Every read failure returns
 * "not cooling": the wake path must never die on the guard.
 */
export async function isIssueCoolingDown(
  db: Db,
  companyId: string,
  issueId: string,
  settings: Pick<SwarmSettings, "cooldownBaseMin" | "cooldownCeilingHours">,
  now: Date = new Date(),
): Promise<IssueCoolingStatus> {
  try {
    if (!issueId) return NOT_COOLING;

    const rows = await db
      .select({
        status: heartbeatRuns.status,
        livenessState: heartbeatRuns.livenessState,
        finishedAt: heartbeatRuns.finishedAt,
        startedAt: heartbeatRuns.startedAt,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          eq(heartbeatRuns.invocationSource, "automation"),
          inArray(heartbeatRuns.status, COOLING_TERMINAL_STATUSES),
        ),
      )
      .orderBy(desc(heartbeatRuns.finishedAt))
      .limit(16);
    if (rows.length === 0) return NOT_COOLING;

    const last = rows[0]!;
    const finishedAt = last.finishedAt;
    if (!finishedAt) return NOT_COOLING;

    const issueRow = await db
      .select({ status: issues.status })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId), isNull(issues.hiddenAt)))
      .limit(1)
      .then((r) => r[0] ?? null);
    if (!issueRow) return NOT_COOLING;

    if (!runIsStale(last, issueRow.status)) return NOT_COOLING;

    // Movement since the stale run cancels the cooling (acceptance "комментарий
    // по задаче снимает остывание"). Deleted comments do not count.
    const oldestFinished = rows.reduce<Date>(
      (min, r) => (r.finishedAt && r.finishedAt < min ? r.finishedAt : min),
      finishedAt,
    );
    const moves = await taskMovementTimes(db, companyId, issueId, oldestFinished);
    if (moves.some((t) => t > finishedAt.getTime())) return NOT_COOLING;

    // Consecutive stale runs counted back from the newest, stopping at a
    // healthy run or at movement between two runs (after the older one
    // finished, before the newer one started).
    let staleCount = 0;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      const healthy =
        row.status === "succeeded" && HEALTHY_LIVENESS.has(row.livenessState ?? "");
      if (healthy) break;
      if (i > 0 && row.finishedAt) {
        const newer = rows[i - 1]!;
        const newerStart = (newer.startedAt ?? newer.createdAt).getTime();
        const from = row.finishedAt.getTime();
        if (moves.some((t) => t > from && t < newerStart)) break;
      }
      staleCount += 1;
    }
    staleCount = Math.max(1, staleCount);

    const periodMs = swarmCoolingPeriodMs(staleCount, settings);
    const deadline = finishedAt.getTime() + periodMs;
    if (deadline <= now.getTime()) return NOT_COOLING;

    return {
      cooling: true,
      staleCount,
      cooldownMin: Math.round(periodMs / 60_000),
      reason:
        last.livenessState === "blocked"
          ? "blocked"
          : last.livenessState === "needs_followup"
            ? "needs_followup"
            : last.status,
      nextWakeAt: new Date(deadline),
    };
  } catch {
    return NOT_COOLING;
  }
}

/** Timestamps (ms) of real task movement after `since`: comments and movement activity. */
async function taskMovementTimes(
  db: Db,
  companyId: string,
  issueId: string,
  since: Date,
): Promise<number[]> {
  const after = new Date(since.getTime() + 1);
  const comments = await db
    .select({ at: issueComments.createdAt })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.issueId, issueId),
        gte(issueComments.createdAt, after),
        isNull(issueComments.deletedAt),
      ),
    )
    .limit(200);
  const acts = await db
    .select({ at: activityLog.createdAt })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, issueId),
        inArray(activityLog.action, MOVEMENT_ACTIVITY_ACTIONS),
        gte(activityLog.createdAt, after),
      ),
    )
    .limit(200);
  return [...comments, ...acts].map((r) => r.at.getTime());
}

/** Read the `general.swarm` block; never throws — defaults on any failure. */
export async function readSwarmSettings(db: Db): Promise<Required<SwarmSettings>> {
  try {
    const row = await db
      .select({ general: instanceSettings.general })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, "default"))
      .limit(1)
      .then((r) => r[0] ?? null);
    const general = (row?.general ?? {}) as Record<string, unknown>;
    return resolveSwarmSettings(general.swarm);
  } catch {
    return resolveSwarmSettings(undefined);
  }
}

/**
 * The T4 read-model: recent automatic runs of tasks that are currently in a
 * cooling window, with the reason and the next allowed wake time. One query
 * fetches the candidate terminal runs of the last ceiling window; the cooling
 * decision per issue reuses `isIssueCoolingDown` so the list and the wake
 * path can never disagree.
 */
export async function listCoolingIssues(
  db: Db,
  companyId: string,
  settings: Required<SwarmSettings>,
  now: Date = new Date(),
  limit = 50,
): Promise<
  Array<{
    issueId: string;
    identifier: string | null;
    title: string;
    reason: string | null;
    staleCount: number;
    cooldownMin: number;
    nextWakeAt: Date | null;
  }>
> {
  const horizonMs =
    (settings.cooldownCeilingHours ?? 24) * 60 * 60_000 + 60 * 60_000;
  const candidates = await db
    .select({
      issueId: sql<string>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
      finishedAt: heartbeatRuns.finishedAt,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.invocationSource, "automation"),
        inArray(heartbeatRuns.status, COOLING_TERMINAL_STATUSES),
        gte(heartbeatRuns.finishedAt, new Date(now.getTime() - horizonMs)),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' is not null`,
      ),
    )
    .orderBy(desc(heartbeatRuns.finishedAt))
    .limit(400);

  const seen = new Set<string>();
  const out: Array<{
    issueId: string;
    identifier: string | null;
    title: string;
    reason: string | null;
    staleCount: number;
    cooldownMin: number;
    nextWakeAt: Date | null;
  }> = [];
  for (const row of candidates) {
    if (!row.issueId || seen.has(row.issueId)) continue;
    seen.add(row.issueId);
    const status = await isIssueCoolingDown(db, companyId, row.issueId, settings, now);
    if (!status.cooling) continue;
    const issueRow = await db
      .select({
        title: issues.title,
        identifier: issues.identifier,
      })
      .from(issues)
      .where(and(eq(issues.id, row.issueId), eq(issues.companyId, companyId), isNull(issues.hiddenAt)))
      .limit(1)
      .then((r) => r[0] ?? null);
    if (!issueRow) continue;
    out.push({
      issueId: row.issueId,
      identifier: issueRow.identifier ?? null,
      title: issueRow.title,
      reason: status.reason,
      staleCount: status.staleCount,
      cooldownMin: status.cooldownMin,
      nextWakeAt: status.nextWakeAt,
    });
    if (out.length >= limit) break;
  }
  out.sort((a, b) => (b.nextWakeAt?.getTime() ?? 0) - (a.nextWakeAt?.getTime() ?? 0));
  return out;
}
