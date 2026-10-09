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

/** One automatic terminal run, as the pure cooling decision sees it. */
export interface CoolingRun {
  agentId: string | null;
  status: string;
  livenessState: string | null;
  finishedAt: Date | null;
  startedAt: Date | null;
  createdAt: Date;
}

/** One candidate task-movement record (comment or activity) with its actor. */
export interface TaskMovement {
  at: number;
  actorType: "user" | "agent" | "system";
  /** Agent id for `agent` actors; user id for `user`; free text for `system`. */
  actorId: string | null;
}

/**
 * Does this movement count as real task movement relative to a stale run of
 * `runAgentId`? Only a user, or an agent other than the one whose run went
 * stale. System actors (the run itself, execution-recovery, automation,
 * workspace runtime) never count: they write `issue.updated` and comments
 * after `finishedAt` in exactly the idle_pickup -> blocked loop the cooling
 * exists to catch.
 */
export function isRealTaskMovement(m: TaskMovement, runAgentId: string | null): boolean {
  if (m.actorType === "user") return true;
  if (m.actorType === "agent") return !!m.actorId && m.actorId !== runAgentId;
  return false;
}

/**
 * Pure cooling decision (§4.3). `runs` are terminal automatic runs, newest
 * first (by finishedAt); `moves` are candidate movement records after the
 * oldest run. No I/O, no clock: other swarm branches call this through an
 * adapter, so keep the signature stable.
 */
export function decideIssueCooling(input: {
  issueStatus: string;
  runs: CoolingRun[];
  moves: TaskMovement[];
  settings: Pick<SwarmSettings, "cooldownBaseMin" | "cooldownCeilingHours">;
  now: Date;
}): IssueCoolingStatus {
  const { runs, issueStatus, settings, now } = input;
  if (runs.length === 0) return NOT_COOLING;
  const last = runs[0]!;
  const finishedAt = last.finishedAt;
  if (!finishedAt) return NOT_COOLING;
  if (!runIsStale(last, issueStatus)) return NOT_COOLING;

  // Movement since the stale run cancels the cooling.
  const movesAfterLast = input.moves.filter(
    (m) => m.at > finishedAt.getTime() && isRealTaskMovement(m, last.agentId),
  );
  if (movesAfterLast.length > 0) return NOT_COOLING;

  // Consecutive stale runs counted back from the newest, stopping at a
  // healthy run or at real movement between two runs.
  let staleCount = 0;
  for (let i = 0; i < runs.length; i += 1) {
    const row = runs[i]!;
    const healthy =
      row.status === "succeeded" && HEALTHY_LIVENESS.has(row.livenessState ?? "");
    if (healthy) break;
    if (i > 0 && row.finishedAt) {
      const newer = runs[i - 1]!;
      const newerStart = (newer.startedAt ?? newer.createdAt).getTime();
      const from = row.finishedAt.getTime();
      if (input.moves.some((m) => m.at > from && m.at < newerStart && isRealTaskMovement(m, row.agentId))) break;
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
}

/**
 * Cooling evaluation for one issue (§4.3). Stable port: other swarm branches
 * call it through an adapter. Reads the last automatic terminal runs and the
 * task movement (comments and movement activity by a user or another agent;
 * never `updatedAt`, never system actors), then defers to the pure
 * `decideIssueCooling`. `now` is injectable. Every read failure returns
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
        agentId: heartbeatRuns.agentId,
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
    const finishedAt = rows[0]!.finishedAt;
    if (!finishedAt) return NOT_COOLING;

    const issueRow = await db
      .select({ status: issues.status })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId), isNull(issues.hiddenAt)))
      .limit(1)
      .then((r) => r[0] ?? null);
    if (!issueRow) return NOT_COOLING;

    const oldestFinished = rows.reduce<Date>(
      (min, r) => (r.finishedAt && r.finishedAt < min ? r.finishedAt : min),
      finishedAt,
    );
    const moves = await taskMovements(db, companyId, issueId, oldestFinished);
    return decideIssueCooling({ issueStatus: issueRow.status, runs: rows, moves, settings, now });
  } catch {
    return NOT_COOLING;
  }
}

/** Movement candidates after `since` with their actors: comments and movement activity. */
async function taskMovements(
  db: Db,
  companyId: string,
  issueId: string,
  since: Date,
): Promise<TaskMovement[]> {
  const after = new Date(since.getTime() + 1);
  const comments = await db
    .select({
      at: issueComments.createdAt,
      authorUserId: issueComments.authorUserId,
      authorAgentId: issueComments.authorAgentId,
    })
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
    .select({
      at: activityLog.createdAt,
      actorType: activityLog.actorType,
      actorId: activityLog.actorId,
    })
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
  const out: TaskMovement[] = [];
  for (const c of comments) {
    if (c.authorUserId) out.push({ at: c.at.getTime(), actorType: "user", actorId: c.authorUserId });
    else if (c.authorAgentId) out.push({ at: c.at.getTime(), actorType: "agent", actorId: c.authorAgentId });
    else out.push({ at: c.at.getTime(), actorType: "system", actorId: null });
  }
  for (const a of acts) {
    const t = a.actorType === "user" || a.actorType === "agent" ? a.actorType : "system";
    out.push({ at: a.at.getTime(), actorType: t, actorId: a.actorId });
  }
  return out;
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
