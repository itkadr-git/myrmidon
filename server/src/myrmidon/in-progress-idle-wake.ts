import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { agentWakeupRequests, agents, companies, heartbeatRuns, issues, issueWorkProducts, type Db } from "@myrmidon/db";
import { logger } from "../middleware/logger.js";
import { hasCoveringWake, idlePickupCandidateRows, type IdleWakeBudget } from "./idle-pickup.js";
import {
  countRunsWithoutCommit,
  isRunCapNoCommitRole,
  loadTaskRunsWithoutCommitLimit,
  readLatestManualUnblockAt,
  readRunCapNoCommitHistory,
  readTaskCurrentHeadSha,
} from "./run-cap-no-commit.js";

/**
 * In-progress safety wake (OPE-13202).
 *
 * A task in `in_progress` whose executor has no run and no wake in the queue is
 * not moving: on 15.11 seven engineers held 1.6.9 tasks in this state for 5-30
 * minutes with nothing to wake them. Idle pickup is the ordinary path; this is
 * the net under it with a time limit of its own. When such a task has stood idle
 * for `runPriority.inProgressIdleWakeMinutes` (default 20) the board wakes the
 * executor (`source=automation`, `reason=in_progress_no_run`, with the issue)
 * and writes the reason to the task's activity feed.
 *
 * Kept apart from the post-review wake (OPE-13194), the release focus of wakes
 * (OPE-13199, deferred in the wake admission, so it applies to this wake too)
 * and `runPriority.strictReleaseFocus` (OPE-13200).
 *
 * Not woken: a task whose PR head has CI in progress (the CI result wakes it), a
 * task at the runs-without-commit cap (it is parked for a person), a task with a
 * blocker, a hold, a pending interaction or an open child (the same prefilter
 * idle pickup uses), an executor that has a live run or is paused / in
 * maintenance. One wake per task per window: the wake itself, a run and any
 * wake request on the task all restart the idle clock, and a refused wake is
 * remembered in memory so the next pass does not retry it at once.
 */

export const IN_PROGRESS_NO_RUN_REASON = "in_progress_no_run";
export const IN_PROGRESS_NO_RUN_ACTOR = "in_progress_idle_wake";
export const IN_PROGRESS_NO_RUN_ACTIVITY_ACTION = "issue.in_progress_no_run_wake_emitted";
/** Passes closer than this are skipped (the tick of the heartbeat is faster). */
export const IN_PROGRESS_IDLE_WAKE_PASS_INTERVAL_MS = 30_000;
const CANDIDATE_LIMIT = 200;
const MINUTE_MS = 60_000;
const ACTIVE_CI_STATUSES = new Set(["queued", "in_progress", "pending"]);

export interface InProgressIdleWakeDeps {
  db: Db;
  /** Minutes in force (`runPriority.inProgressIdleWakeMinutes`); 0 = off. */
  readIdleMinutes: () => number;
  enqueueWakeup: (
    agentId: string,
    opts: {
      source: "automation";
      triggerDetail: "system";
      reason: string;
      idempotencyKey: string;
      requestedByActorType: "system";
      requestedByActorId: string;
      payload: Record<string, unknown>;
      contextSnapshot: Record<string, unknown>;
    },
  ) => Promise<unknown>;
  isAgentInvokable: (agent: { id: string; companyId: string }) => Promise<boolean>;
  isAgentUnderMaintenance: (agentId: string) => Promise<boolean>;
  /** The company wake budget shared with idle pickup; absent = unbudgeted. */
  budget?: IdleWakeBudget;
  logActivity?: (input: {
    companyId: string;
    actorType: "system";
    actorId: string;
    agentId: string | null;
    runId: string | null;
    action: string;
    entityType: string;
    entityId: string;
    details: Record<string, unknown>;
  }) => Promise<void>;
}

export interface InProgressIdleWakeResult {
  considered: number;
  woken: number;
  issueIds: string[];
}

/** Whether the stored PR work-product metadata says the head CI is still running. */
export function isHeadCiInProgress(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const activeCi = (metadata as Record<string, unknown>).activeCi;
  if (!activeCi || typeof activeCi !== "object" || Array.isArray(activeCi)) return false;
  const status = (activeCi as Record<string, unknown>).status;
  return typeof status === "string" && ACTIVE_CI_STATUSES.has(status.trim().toLowerCase());
}

/** True once the task has stood idle for the whole window. */
export function isIdleLongEnough(idleSince: Date, now: Date, minutes: number): boolean {
  return minutes > 0 && now.getTime() - idleSince.getTime() >= minutes * MINUTE_MS;
}

async function readLatestPullRequestMetadata(db: Db, companyId: string, issueId: string): Promise<unknown> {
  const [row] = await db
    .select({ metadata: issueWorkProducts.metadata })
    .from(issueWorkProducts)
    .where(
      and(
        eq(issueWorkProducts.companyId, companyId),
        eq(issueWorkProducts.issueId, issueId),
        eq(issueWorkProducts.type, "pull_request"),
      ),
    )
    .orderBy(desc(issueWorkProducts.createdAt))
    .limit(1);
  return row?.metadata ?? null;
}

/**
 * The last moment anything moved on the task for this executor: the issue row
 * itself, a run of the executor on it (any status) or a wake request for it.
 */
async function readIdleSince(
  db: Db,
  companyId: string,
  agentId: string,
  issue: { id: string; updatedAt: Date },
): Promise<Date> {
  const issueId = issue.id;
  const [lastRun, lastWake] = await Promise.all([
    db
      .select({
        at: sql<Date | null>`max(greatest(${heartbeatRuns.createdAt}, coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.createdAt})))`,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          sql`(${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId} or ${heartbeatRuns.contextSnapshot}->'_paperclipWakeContext'->>'issueId' = ${issueId})`,
        ),
      )
      .then((rows) => rows[0]?.at ?? null),
    db
      .select({ at: sql<Date | null>`max(${agentWakeupRequests.requestedAt})` })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, agentId),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
        ),
      )
      .then((rows) => rows[0]?.at ?? null),
  ]);
  const times: number[] = [issue.updatedAt.getTime()];
  for (const value of [lastRun, lastWake]) {
    if (value === null || value === undefined) continue;
    const ms = new Date(value as Date | string).getTime();
    if (Number.isFinite(ms)) times.push(ms);
  }
  return new Date(Math.max(...times));
}

/** True when the task sits at the runs-without-commit cap (it is for a person, not for a wake). */
async function isAtRunCap(
  db: Db,
  agent: { id: string; role: string | null; companyId: string },
  issueId: string,
  limit: number,
): Promise<boolean> {
  if (limit <= 0 || !isRunCapNoCommitRole(agent.role)) return false;
  const headSha = await readTaskCurrentHeadSha(db, agent.companyId, issueId);
  if (!headSha) return false;
  const [history, resetAfter] = await Promise.all([
    readRunCapNoCommitHistory(db, agent.companyId, issueId, agent.id),
    readLatestManualUnblockAt(db, agent.companyId, issueId),
  ]);
  return countRunsWithoutCommit(history, headSha, { resetAfter }).count >= limit;
}

export interface InProgressIdleWakeSweeper {
  sweep(now?: Date): Promise<InProgressIdleWakeResult>;
  resetForTest(): void;
}

export function createInProgressIdleWakeSweeper(deps: InProgressIdleWakeDeps): InProgressIdleWakeSweeper {
  let lastPassAtMs = 0;
  /** Issue id -> when this process last tried to wake it (also for a refused wake). */
  const lastAttemptMs = new Map<string, number>();
  return {
    resetForTest() {
      lastPassAtMs = 0;
      lastAttemptMs.clear();
    },
    async sweep(now = new Date()) {
      const result: InProgressIdleWakeResult = { considered: 0, woken: 0, issueIds: [] };
      const minutes = deps.readIdleMinutes();
      if (!(minutes > 0)) return result;
      if (lastPassAtMs !== 0 && now.getTime() - lastPassAtMs < IN_PROGRESS_IDLE_WAKE_PASS_INTERVAL_MS) return result;
      lastPassAtMs = now.getTime();
      const cutoff = new Date(now.getTime() - minutes * MINUTE_MS);

      // Cheap prefilter: in_progress tasks of an agent whose row has not moved
      // for the window. The per-task checks below look at the runs and wakes.
      const stale = await deps.db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          agentId: issues.assigneeAgentId,
          updatedAt: issues.updatedAt,
          role: agents.role,
        })
        .from(issues)
        .innerJoin(agents, eq(agents.id, issues.assigneeAgentId))
        .innerJoin(companies, eq(companies.id, issues.companyId))
        .where(
          and(
            eq(issues.status, "in_progress"),
            eq(companies.status, "active"),
            sql`${issues.assigneeUserId} is null`,
            sql`${issues.updatedAt} <= ${cutoff.toISOString()}::timestamptz`,
          ),
        )
        .orderBy(issues.updatedAt)
        .limit(CANDIDATE_LIMIT);
      if (stale.length === 0) return result;

      const byAgent = new Map<string, typeof stale>();
      for (const row of stale) {
        if (!row.agentId) continue;
        const list = byAgent.get(row.agentId) ?? [];
        list.push(row);
        byAgent.set(row.agentId, list);
      }
      const capLimitByCompany = new Map<string, number>();

      for (const [agentId, rows] of byAgent) {
        const agent = { id: agentId, companyId: rows[0]!.companyId, role: rows[0]!.role };
        try {
          if (!(await deps.isAgentInvokable(agent))) continue;
          if (await deps.isAgentUnderMaintenance(agentId)) continue;
          // An agent with a live run is busy: the wake would only queue behind it.
          const [live] = await deps.db
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.companyId, agent.companyId),
                eq(heartbeatRuns.agentId, agentId),
                inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
              ),
            )
            .limit(1);
          if (live) continue;

          // The same prefilter idle pickup uses: blockers, containers, holds,
          // monitors, pending interactions, private and chat tasks.
          const ready = new Set(
            (await idlePickupCandidateRows(deps.db, agent.companyId, agentId))
              .filter((candidate) => candidate.status === "in_progress")
              .map((candidate) => candidate.id),
          );
          for (const issue of rows) {
            if (!ready.has(issue.id)) continue;
            result.considered += 1;
            const lastTry = lastAttemptMs.get(issue.id);
            if (lastTry !== undefined && now.getTime() - lastTry < minutes * MINUTE_MS) continue;
            const idleSince = await readIdleSince(deps.db, agent.companyId, agentId, issue);
            if (!isIdleLongEnough(idleSince, now, minutes)) continue;
            if (await hasCoveringWake(deps.db, agent, issue.id)) continue;
            if (isHeadCiInProgress(await readLatestPullRequestMetadata(deps.db, agent.companyId, issue.id))) continue;
            let capLimit = capLimitByCompany.get(agent.companyId);
            if (capLimit === undefined) {
              capLimit = await loadTaskRunsWithoutCommitLimit(deps.db);
              capLimitByCompany.set(agent.companyId, capLimit);
            }
            if (await isAtRunCap(deps.db, agent, issue.id, capLimit)) continue;
            if (deps.budget && !deps.budget.tryConsume(agent.companyId)) return result;

            lastAttemptMs.set(issue.id, now.getTime());
            const idleMinutes = Math.floor((now.getTime() - idleSince.getTime()) / MINUTE_MS);
            const idempotencyKey = `${IN_PROGRESS_NO_RUN_REASON}:${issue.id}:${Math.floor(now.getTime() / (minutes * MINUTE_MS))}`;
            const wake = await deps.enqueueWakeup(agentId, {
              source: "automation",
              triggerDetail: "system",
              reason: IN_PROGRESS_NO_RUN_REASON,
              idempotencyKey,
              requestedByActorType: "system",
              requestedByActorId: IN_PROGRESS_NO_RUN_ACTOR,
              payload: { issueId: issue.id, idleMinutes, thresholdMinutes: minutes },
              contextSnapshot: {
                issueId: issue.id,
                taskKey: issue.id,
                source: IN_PROGRESS_NO_RUN_ACTOR,
                wakeReason: IN_PROGRESS_NO_RUN_REASON,
              },
            });
            if (!wake) continue;
            result.woken += 1;
            result.issueIds.push(issue.id);
            await deps.logActivity?.({
              companyId: agent.companyId,
              actorType: "system",
              actorId: IN_PROGRESS_NO_RUN_ACTOR,
              agentId,
              runId: null,
              action: IN_PROGRESS_NO_RUN_ACTIVITY_ACTION,
              entityType: "issue",
              entityId: issue.id,
              details: {
                reason: IN_PROGRESS_NO_RUN_REASON,
                idleMinutes,
                thresholdMinutes: minutes,
                idempotencyKey,
              },
            });
            // One wake per executor per pass: the next pass sees its live run.
            break;
          }
        } catch (err) {
          logger.warn({ err, agentId }, "in-progress idle wake: the agent was skipped after an error");
        }
      }
      if (result.woken > 0) {
        logger.warn({ woken: result.woken, issueIds: result.issueIds }, "in-progress idle wake woke idle executors");
      }
      return result;
    },
  };
}
