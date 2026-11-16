import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  companies,
  heartbeatRuns,
  issues,
  issueWorkProducts,
  type Db,
} from "@myrmidon/db";
import { logger } from "../middleware/logger.js";
import { readRunIdsWithPrHeadChange } from "../services/pr-head-change-progress.js";
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
 * Continuation after progress: an executor whose last run on the task ended
 * `advanced` and left real progress (the PR head moved inside the run's window)
 * is woken after
 * `CONTINUATION_AFTER_PROGRESS_MINUTES` instead of the full window. A run that
 * pushed a piece of work and stopped (engineers do this: one to two minutes of
 * work, then 10-30 minutes of waiting) should not sit out the idle window; a run
 * without progress keeps the full window, so the guards against empty runs
 * (wake-task-guard, rewake throttle) are not loosened. Every other check below
 * applies to this wake the same way, the release focus included.
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
/** Pages one pass reads at most (200 each): a bound, not a cut of the working set. */
const MAX_PAGES = 50;
const MINUTE_MS = 60_000;
/**
 * The pause before the executor is woken again after a run that left real
 * progress (see "Continuation after progress" above). Short on purpose: the
 * work is mid-way and the engineer knows the next step; the wait only gives the
 * board time to record the push (the PR head-change row comes from GitHub).
 * Never longer than the configured window.
 */
export const CONTINUATION_AFTER_PROGRESS_MINUTES = 2;
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

/**
 * Whether the stored PR work-product metadata says the CI of the CURRENT head is
 * still running. The `activeCi` record carries the head it belongs to; CI of an
 * older head (a new commit was pushed since) must not hold the wake back.
 */
export function isHeadCiInProgress(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const record = metadata as Record<string, unknown>;
  const activeCi = record.activeCi;
  if (!activeCi || typeof activeCi !== "object" || Array.isArray(activeCi)) return false;
  const ci = activeCi as Record<string, unknown>;
  if (typeof ci.status !== "string" || !ACTIVE_CI_STATUSES.has(ci.status.trim().toLowerCase())) return false;
  const ciHead = typeof ci.headSha === "string" ? ci.headSha.trim() : "";
  const currentHead = typeof record.headSha === "string" ? record.headSha.trim() : "";
  // Both heads known and different: the running CI is for a superseded commit.
  if (ciHead && currentHead && ciHead !== currentHead) return false;
  return true;
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

/**
 * Did the executor's last run on the task leave progress that justifies the
 * short wake? True when that run succeeded with liveness `advanced` and moved
 * the head of the task's PR inside its window (`readRunIdsWithPrHeadChange`,
 * the `issue.work_product_head_changed` rows). Only a real push counts:
 * registering a PR or a commit again, documents, other work products, comments
 * and status moves do not (an agent can register its PR on every run). An agent that updates its worklog every run must not be woken
 * every 2 minutes; it keeps the full window. `runId` is the run judged (null
 * when the executor has no run on the task), the key of the "no progress" memory.
 */
export async function lastRunLeftProgress(
  db: Db,
  companyId: string,
  agentId: string,
  issueId: string,
): Promise<{ progress: boolean; runId: string | null }> {
  const [run] = await db
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      livenessState: heartbeatRuns.livenessState,
      createdAt: heartbeatRuns.createdAt,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.agentId, agentId),
        sql`(${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId} or ${heartbeatRuns.contextSnapshot}->'_paperclipWakeContext'->>'issueId' = ${issueId})`,
      ),
    )
    .orderBy(desc(sql`greatest(${heartbeatRuns.createdAt}, coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.createdAt}))`))
    .limit(1);
  if (!run) return { progress: false, runId: null };
  if (run.status !== "succeeded" || run.livenessState !== "advanced") return { progress: false, runId: run.id };
  if ((await readRunIdsWithPrHeadChange(db, companyId, issueId, [run])).has(run.id)) {
    return { progress: true, runId: run.id };
  }
  return { progress: false, runId: run.id };
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

interface StaleRow {
  id: string;
  companyId: string;
  agentId: string | null;
  updatedAt: Date;
  /** The same instant as text, at the column's own precision: the keyset cursor. */
  updatedAtText: string;
  role: string;
}

export interface InProgressIdleWakeSweeper {
  sweep(now?: Date): Promise<InProgressIdleWakeResult>;
  resetForTest(): void;
}

export function createInProgressIdleWakeSweeper(deps: InProgressIdleWakeDeps): InProgressIdleWakeSweeper {
  let lastPassAtMs = 0;
  /** Issue id -> when this process last tried to wake it (also for a refused wake). */
  const lastAttemptMs = new Map<string, number>();
  /**
   * Issue id -> the short check found no progress for this last run: until the
   * full window ends (absolute time) and while the task row is unchanged, the
   * short check does not touch the task again (no queries). A new run or a
   * change of the task row (updatedAt) drops the entry.
   */
  const noProgressUntil = new Map<string, { untilMs: number; runId: string | null; updatedAtMs: number }>();
  return {
    resetForTest() {
      lastPassAtMs = 0;
      lastAttemptMs.clear();
      noProgressUntil.clear();
    },
    async sweep(now = new Date()) {
      const result: InProgressIdleWakeResult = { considered: 0, woken: 0, issueIds: [] };
      const minutes = deps.readIdleMinutes();
      if (!(minutes > 0)) return result;
      if (lastPassAtMs !== 0 && now.getTime() - lastPassAtMs < IN_PROGRESS_IDLE_WAKE_PASS_INTERVAL_MS) return result;
      lastPassAtMs = now.getTime();
      for (const [key, entry] of noProgressUntil) if (entry.untilMs <= now.getTime()) noProgressUntil.delete(key);
      // The prefilter reads with the shorter continuation window; a task that
      // is idle for less than the full window is judged below by its last run.
      const shortMinutes = Math.min(minutes, CONTINUATION_AFTER_PROGRESS_MINUTES);
      const cutoff = new Date(now.getTime() - shortMinutes * MINUTE_MS);

      // Cheap prefilter: in_progress tasks of an agent whose row has not moved
      // for the window, read page by page in (updatedAt, id) order until the set
      // is exhausted. A fixed first page would let rows that are always excluded
      // below (blocked, busy executor, CI running, cap) starve every task behind
      // them. The per-task checks look at the runs and wakes.
      const capLimitByCompany = new Map<string, number>();
      const agentGate = new Map<string, { ok: boolean; ready: Set<string> }>();
      const wokenAgents = new Set<string>();
      const seen = new Set<string>();
      let cursor: { updatedAtText: string; id: string } | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const stale: StaleRow[] = await deps.db
          .select({
            id: issues.id,
            companyId: issues.companyId,
            agentId: issues.assigneeAgentId,
            updatedAt: issues.updatedAt,
            updatedAtText: sql<string>`${issues.updatedAt}::text`,
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
              cursor
                ? sql`(${issues.updatedAt}, ${issues.id}) > (${cursor.updatedAtText}::timestamptz, ${cursor.id}::uuid)`
                : undefined,
            ),
          )
          .orderBy(issues.updatedAt, issues.id)
          .limit(CANDIDATE_LIMIT);
        if (stale.length === 0) break;
        const lastRow = stale[stale.length - 1]!;
        cursor = { updatedAtText: lastRow.updatedAtText, id: lastRow.id };

        for (const issue of stale) {
          if (seen.has(issue.id)) continue;
          seen.add(issue.id);
          const remembered = noProgressUntil.get(issue.id);
          if (remembered && remembered.updatedAtMs === issue.updatedAt.getTime() && remembered.untilMs > now.getTime()) continue;
          const agentId = issue.agentId;
          if (!agentId || wokenAgents.has(agentId)) continue;
          const agent = { id: agentId, companyId: issue.companyId, role: issue.role };
          try {
            let gate = agentGate.get(agentId);
            if (!gate) {
              gate = { ok: false, ready: new Set<string>() };
              agentGate.set(agentId, gate);
              if (
                (await deps.isAgentInvokable(agent)) &&
                !(await deps.isAgentUnderMaintenance(agentId))
              ) {
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
                if (!live) {
                  gate.ok = true;
                  // The same prefilter idle pickup uses: blockers, containers, holds,
                  // monitors, pending interactions, private and chat tasks.
                  gate.ready = new Set(
                    (await idlePickupCandidateRows(deps.db, agent.companyId, agentId))
                      .filter((candidate) => candidate.status === "in_progress")
                      .map((candidate) => candidate.id),
                  );
                }
              }
            }
            if (!gate.ok || !gate.ready.has(issue.id)) continue;
            result.considered += 1;
            const lastTry = lastAttemptMs.get(issue.id);
            if (lastTry !== undefined && now.getTime() - lastTry < shortMinutes * MINUTE_MS) continue;
            const idleSince = await readIdleSince(deps.db, agent.companyId, agentId, issue);
            if (!isIdleLongEnough(idleSince, now, shortMinutes)) continue;
            // Idle past the short window only: wake now if the last run left progress,
            // otherwise wait for the full window.
            let windowMinutes = minutes;
            let afterProgress = false;
            if (!isIdleLongEnough(idleSince, now, minutes)) {
              const judged = await lastRunLeftProgress(deps.db, agent.companyId, agentId, issue.id);
              if (!judged.progress) {
                noProgressUntil.set(issue.id, {
                  untilMs: idleSince.getTime() + minutes * MINUTE_MS,
                  runId: judged.runId,
                  updatedAtMs: issue.updatedAt.getTime(),
                });
                continue;
              }
              windowMinutes = shortMinutes;
              afterProgress = true;
            }
            // The once-per-window memory. A short continuation wake is tried once per
            // idle spell: when the last try is newer than the idle clock the wake
            // moved nothing (refused or lost), and the task falls back to the full window.
            if (lastTry !== undefined) {
              if (afterProgress ? lastTry >= idleSince.getTime() : now.getTime() - lastTry < windowMinutes * MINUTE_MS) continue;
            }
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
            const idempotencyKey = `${IN_PROGRESS_NO_RUN_REASON}:${issue.id}:${afterProgress ? "p" : "w"}${Math.floor(now.getTime() / (windowMinutes * MINUTE_MS))}`;
            const wake = await deps.enqueueWakeup(agentId, {
              source: "automation",
              triggerDetail: "system",
              reason: IN_PROGRESS_NO_RUN_REASON,
              idempotencyKey,
              requestedByActorType: "system",
              requestedByActorId: IN_PROGRESS_NO_RUN_ACTOR,
              payload: { issueId: issue.id, idleMinutes, thresholdMinutes: windowMinutes, afterProgress },
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
            // One wake per executor per pass: the next pass sees its live run.
            wokenAgents.add(agentId);
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
                thresholdMinutes: windowMinutes,
                afterProgress,
                idempotencyKey,
              },
            });
          } catch (err) {
            logger.warn({ err, agentId }, "in-progress idle wake: the task was skipped after an error");
          }
        }
        if (stale.length < CANDIDATE_LIMIT) break;
      }
      if (result.woken > 0) {
        logger.warn({ woken: result.woken, issueIds: result.issueIds }, "in-progress idle wake woke idle executors");
      }
      return result;
    },
  };
}
