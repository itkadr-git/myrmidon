import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { agentWakeupRequests, agents, companies, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
// myrmidon(TEAM-LIVENESS-SETTINGS): the instance settings (and the per-agent card
// switch) this pass obeys, so an operator can change the throttle and the wake
// budget without restarting the server — a restart drops every run in flight.
import { resolveAgentTeamLiveness, type ResolvedTeamLiveness } from "@paperclipai/shared";
import { issueHasNoExecutionHold, wakeNotParkedOnExecutionHold } from "./settled-holds/ready-predicate.js";

/**
 * Idle pickup (IDLE-PICKUP, Myrmidon 1.3).
 *
 * A board that only wakes an agent on assignment leaves the agent idle
 * whenever a run finishes and another ready task is already assigned: on
 * 2026-09-29 the team sat idle for 3 hours with 19 todo tasks, and the
 * operator's only workaround was to reassign a task by hand. This module
 * makes the board wake the agent itself.
 *
 * Two triggers call `idlePickupForAgent`:
 *
 * - the release path: right after a run released its issue execution lock
 *   (`releaseIssueExecutionAndPromote`), for the agent that finished the run;
 * - the scheduler tick: every `MYRMIDON_IDLE_PICKUP_INTERVAL_SEC` seconds
 *   for every invokable agent (a safety net for missed releases, server
 *   restarts and reassignments).
 *
 * The wake is idempotent by construction, not by a stored dedup key: an issue
 * is only ever woken while it truly has no live run and no queued wake. Once
 * the wake lands a `queued`/`running`/`scheduled_retry` run, a later pass
 * (a racing pass, the next tick) sees the issue as no longer idle and leaves
 * it alone. The idempotency key handed to `enqueueWakeup` is for tracing
 * only; it is not a uniqueness constraint the database enforces for this
 * prefix.
 *
 * All the hard gates (agent invokability and therefore pause, maintenance
 * mode, run admission limits, per-agent concurrency, daily caps, budget
 * blocks, tree pause holds) are enforced by `enqueueWakeup` itself, so this
 * module reuses them instead of re-implementing them. Wakes over a limit
 * simply stay queued and the normal queued-run sweep starts them later.
 */

export const IDLE_PICKUP_INTERVAL_SEC_ENV = "MYRMIDON_IDLE_PICKUP_INTERVAL_SEC";
export const IDLE_PICKUP_ENABLED_ENV = "MYRMIDON_IDLE_PICKUP_ENABLED";
export const IDLE_PICKUP_RECENT_SUCCESS_WINDOW_MS_ENV = "MYRMIDON_IDLE_PICKUP_RECENT_SUCCESS_WINDOW_MS";
export const IDLE_PICKUP_WAKE_BUDGET_PER_MIN_ENV = "MYRMIDON_IDLE_PICKUP_WAKE_BUDGET_PER_MIN";
export const IDLE_PICKUP_WAKE_BATCH_ENV = "MYRMIDON_IDLE_PICKUP_WAKE_BATCH";
export const IDLE_WAKE_REASON = "idle_pickup";
export const IDLE_WAKE_IDEMPOTENCY_PREFIX = "idle_pickup";

/** Default: the sweep runs on every scheduler tick (about 30 s), like the other recovery passes. */
export const DEFAULT_IDLE_PICKUP_INTERVAL_SEC = 30;
export const MIN_IDLE_PICKUP_INTERVAL_SEC = 5;
/** Default: an issue whose own run succeeded this recently is left to the handoff/recovery paths. */
export const DEFAULT_IDLE_PICKUP_RECENT_SUCCESS_WINDOW_MS = 15 * 60 * 1000;

/**
 * Company-wide wake budget: at most this many idle-pickup wakes for one company
 * inside one minute. A board with twenty idle agents must not start twenty runs
 * at once: the 28.09 OOM came from exactly that burst, and every wake is a full
 * LLM session. The budget is per company, so one busy company never starves
 * another.
 */
export const DEFAULT_IDLE_PICKUP_WAKE_BUDGET_PER_MIN = 5;
export const MAX_IDLE_PICKUP_WAKE_BUDGET_PER_MIN = 60;
/**
 * How many of the minute's wakes one sweep pass may emit for one company: the
 * wakes go out in batches instead of one burst, and the rest wait for the next
 * pass. Clamped to the minute budget (a batch larger than the budget would only
 * spend the whole window at once).
 */
export const DEFAULT_IDLE_PICKUP_WAKE_BATCH = 5;
/** Window the company budget is counted over. */
export const IDLE_PICKUP_WAKE_WINDOW_MS = 60_000;

const WAKEABLE_ISSUE_STATUSES = ["todo", "in_progress"] as const;
const LIVE_HEARTBEAT_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;

/** Interval in seconds; invalid or too-small values fall back to the default. */
export function readIdlePickupIntervalSec(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[IDLE_PICKUP_INTERVAL_SEC_ENV]?.trim();
  if (!raw) return DEFAULT_IDLE_PICKUP_INTERVAL_SEC;
  if (!/^\d+$/.test(raw)) return DEFAULT_IDLE_PICKUP_INTERVAL_SEC;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return DEFAULT_IDLE_PICKUP_INTERVAL_SEC;
  return Math.max(MIN_IDLE_PICKUP_INTERVAL_SEC, value);
}

/**
 * The feature ships enabled (a defect fix per CONVENTIONS.md §8): an unset or
 * unrecognized value keeps it on. Only an explicit off value disables it.
 */
export function readIdlePickupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[IDLE_PICKUP_ENABLED_ENV]?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

/**
 * Window in ms during which a successful run on an issue suppresses an
 * idle-pickup wake for that same issue (the successful-run-handoff and
 * stranded-recovery paths own the next step there). `0` disables the
 * suppression; invalid values fall back to the default.
 */
export function readIdlePickupRecentSuccessWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[IDLE_PICKUP_RECENT_SUCCESS_WINDOW_MS_ENV]?.trim();
  if (!raw) return DEFAULT_IDLE_PICKUP_RECENT_SUCCESS_WINDOW_MS;
  if (!/^\d+$/.test(raw)) return DEFAULT_IDLE_PICKUP_RECENT_SUCCESS_WINDOW_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return DEFAULT_IDLE_PICKUP_RECENT_SUCCESS_WINDOW_MS;
  return value;
}

/** Bounded non-negative integer reader shared by the two budget knobs. */
function readBoundedInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) return fallback;
  return value;
}

export interface IdleWakeBudgetSettings {
  /** Company-wide ceiling of idle-pickup wakes inside one minute. */
  perMinute: number;
  /** Ceiling of wakes one pass may emit for one company. */
  batch: number;
}

/**
 * How many wakes the board may emit for one company. The default is the ticket's
 * own number (at most five a minute); the batch never exceeds the minute budget,
 * so a batch knob above the budget is silently the budget instead of a way to
 * spend the whole window in one pass.
 */
export function readIdleWakeBudgetSettings(env: NodeJS.ProcessEnv = process.env): IdleWakeBudgetSettings {
  const perMinute = readBoundedInt(
    env,
    IDLE_PICKUP_WAKE_BUDGET_PER_MIN_ENV,
    DEFAULT_IDLE_PICKUP_WAKE_BUDGET_PER_MIN,
    1,
    MAX_IDLE_PICKUP_WAKE_BUDGET_PER_MIN,
  );
  const batch = readBoundedInt(
    env,
    IDLE_PICKUP_WAKE_BATCH_ENV,
    DEFAULT_IDLE_PICKUP_WAKE_BATCH,
    1,
    MAX_IDLE_PICKUP_WAKE_BUDGET_PER_MIN,
  );
  return { perMinute, batch: Math.min(perMinute, batch) };
}

/**
 * The company-wide wake budget itself. One instance is shared by every path that
 * emits an idle-pickup wake (the periodic sweeper and the release-path pickup),
 * so "at most five a minute for one company" holds across both instead of per
 * path.
 *
 * The window is process-local and rolls on its own: the board runs one scheduler
 * process, a restart only ever resets the counter towards allowing more wakes,
 * and a denied wake is never lost — the candidate is re-evaluated on the next
 * pass, inside the next window.
 */
export interface IdleWakeBudget {
  /** Takes one wake allowance for the company; false when this minute is spent. */
  tryConsume(companyId: string): boolean;
  /** Allowances the company still has inside the current window. */
  remaining(companyId: string): number;
  /**
   * myrmidon(TEAM-LIVENESS-SETTINGS): the numbers the instance settings page puts
   * in force. The behaviour modules read the settings row asynchronously once per
   * pass (or once per release), and the budget is synchronous, so the caller hands
   * the resolved pair over instead of the budget reading a row per wake. Without
   * a call the budget keeps the reader it was created with (the environment).
   */
  configure(settings: IdleWakeBudgetSettings): void;
  /** Drops every window (tests only). */
  resetForTest(): void;
}

export function createIdleWakeBudget(
  readSettings: () => IdleWakeBudgetSettings = () => readIdleWakeBudgetSettings(),
  nowMs: () => number = () => Date.now(),
): IdleWakeBudget {
  const windows = new Map<string, { startedAtMs: number; used: number }>();
  // myrmidon(TEAM-LIVENESS-SETTINGS): the resolved pair, once a caller has one.
  let configured: IdleWakeBudgetSettings | null = null;
  const current = () => configured ?? readSettings();
  function currentWindow(companyId: string) {
    const at = nowMs();
    const existing = windows.get(companyId);
    if (!existing || at - existing.startedAtMs >= IDLE_PICKUP_WAKE_WINDOW_MS) {
      const fresh = { startedAtMs: at, used: 0 };
      windows.set(companyId, fresh);
      return fresh;
    }
    return existing;
  }
  return {
    remaining(companyId) {
      const { perMinute } = current();
      return Math.max(0, perMinute - currentWindow(companyId).used);
    },
    tryConsume(companyId) {
      const { perMinute } = current();
      const window = currentWindow(companyId);
      if (window.used >= perMinute) return false;
      window.used += 1;
      return true;
    },
    configure(settings) {
      configured = settings;
    },
    resetForTest() {
      windows.clear();
      configured = null;
    },
  };
}

export interface IdlePickupIssueCandidate {
  id: string;
  identifier: string | null;
  priority: string | null;
  blockedTransitionAt: Date | null;
}

export interface IdlePickupDeps {
  db: Db;
  /** Existing wakeup admission path (heartbeat.ts); reuses every limit and gate. */
  enqueueWakeup: (
    agentId: string,
    opts: {
      source?: "automation";
      triggerDetail?: "system";
      reason?: string;
      idempotencyKey?: string;
      requestedByActorType?: "system";
      requestedByActorId?: string;
      contextSnapshot?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
  /**
   * Company-wide wake budget (IDLE-WAKE-BUDGET). One instance is shared by the
   * periodic sweeper and the release-path pickup, so the ceiling holds for the
   * pair. Absent (unit tests that predate it) means unbudgeted.
   */
  budget?: IdleWakeBudget;
  /** Optional activity log for observability; absent in unit tests. */
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
  env?: NodeJS.ProcessEnv;
}

export interface IdlePickupResult {
  /** Issues that received an idle-pickup wake. */
  woken: number;
  /** Ready issues skipped because a wake was already queued or a live run covers them. */
  alreadyActive: number;
  /** Wake attempts that returned null (suppressed by admission) or threw. */
  suppressed: number;
  /** Candidates that reached the loop after the SQL prefilter (blocked issues and containers are excluded there). */
  considered: number;
  /**
   * Ready issues left alone because the company's wake budget for this minute
   * was spent. The candidate is not lost: the next window (and the next pass)
   * picks it up again.
   */
  budgetSkipped: number;
  issueIds: string[];
}

const IDLE_PICKUP_RESULT_ZERO: Omit<IdlePickupResult, "issueIds"> = {
  woken: 0,
  alreadyActive: 0,
  suppressed: 0,
  considered: 0,
  budgetSkipped: 0,
};

/** A fresh zero result; a bare spread of IDLE_PICKUP_RESULT_ZERO would share the issueIds array across calls. */
function emptyIdlePickupResult(): IdlePickupResult {
  return { ...IDLE_PICKUP_RESULT_ZERO, issueIds: [] };
}

/**
 * The candidate order the idle-pickup scheduler picks in — and the order the
 * manual-wake task binding (WAKE-BIND) reuses, so both agree on which ready task
 * is "top": highest priority first, oldest blocked-transition breaks ties.
 */
export function orderIdlePickupCandidates(
  candidates: readonly IdlePickupIssueCandidate[],
): IdlePickupIssueCandidate[] {
  return [...candidates].sort((left, right) => {
    const leftRank = issuePriorityRank(left.priority);
    const rightRank = issuePriorityRank(right.priority);
    if (leftRank !== rightRank) return leftRank - rightRank;
    return (left.blockedTransitionAt?.getTime() ?? 0) - (right.blockedTransitionAt?.getTime() ?? 0);
  });
}

function issuePriorityRank(priority: string | null | undefined): number {
  switch (priority) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
    default:
      return 4;
  }
}

/**
 * SQL prefilter for one agent's idle-pickup candidates: assigned
 * `todo`/`in_progress`, visible, agent-assigned (not user-assigned), not a
 * chat conversation, no unresolved `blocks` relation, no open child issue,
 * no execution hold (HOLD-READY). The remaining checks (live run, queued wake) need per-issue lookups and
 * run in the loop in `idlePickupForAgent`.
 */
function idlePickupCandidateRows(db: Db, companyId: string, agentId: string) {
  return db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      priority: issues.priority,
      blockedTransitionAt: issues.blockedTransitionAt,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.assigneeAgentId, agentId),
        isNull(issues.assigneeUserId),
        isNull(issues.hiddenAt),
        isNull(issues.conversationAgentId),
        inArray(issues.status, [...WAKEABLE_ISSUE_STATUSES]),
        // Not blocked by an unresolved blocker: no `blocks` edge whose blocker
        // is anything other than `done`. This mirrors the board's readiness
        // rule (only a done blocker resolves its dependent): an open blocker
        // and a cancelled blocker both suppress the wake — for a cancelled
        // blocker an operator must remove or replace the relation explicitly.
        // A done blocker whose execution workspace has not finalized yet is
        // the one gap this prefilter accepts; the vendor's
        // `issue_blockers_resolved` path re-fires the wake when the
        // finalization lands, so that window closes itself.
        sql`not exists (
          select 1
          from issue_relations ir
            join issues blocker on blocker.id = ir.issue_id and blocker.company_id = ${issues.companyId}
          where ir.company_id = ${issues.companyId}
            and ir.related_issue_id = ${issues.id}
            and ir.type = 'blocks'
            and blocker.status <> 'done'
        )`,
        // Not a container: an issue with an open child is a plan container,
        // and the children are the real work, not the parent.
        sql`not exists (
          select 1
          from issues child
          where child.company_id = ${issues.companyId}
            and child.parent_id = ${issues.id}
            and child.status not in ('done', 'cancelled')
        )`,
        // Not mid-decomposition: an issue with an in-flight accepted-plan
        // claim (`issue_plan_decompositions.status = 'in_flight'`) is waiting
        // for the claim mechanism (child creation on acceptance, corrective
        // continuation on failure), not for a fresh generic wake. Waking it
        // here races that machinery — CI on the first push showed a test wake
        // followed by an idle-pickup wake on the other planning issue and a
        // third corrective run, tripling adapter executions.
        sql`not exists (
          select 1
          from issue_plan_decompositions decomp
          where decomp.company_id = ${issues.companyId}
            and decomp.source_issue_id = ${issues.id}
            and decomp.status = 'in_flight'
        )`,
        // myrmidon(HOLD-READY): not held by an execution hold. The wake
        // admission parks every automatic wake of such an issue
        // (`deferred_issue_execution` + `executionWait`), so reporting it as
        // ready only produced a parked wake and hid the real reason. A board
        // unblock clears a settled hold (settled-holds/human-unblock.ts), and
        // the issue comes back here on the next pass.
        issueHasNoExecutionHold(db),
      ),
    )
    .orderBy(asc(issues.createdAt))
    .limit(200);
}

/**
 * Wakes the agent's highest-priority ready issue when the agent has no live
 * run for it and no wake already in flight. One wake per pass: the next pass
 * (the next tick, or the next release) picks the next issue once this one has
 * a live run, so an agent with several ready tasks does not start them all at
 * once. Returns the outcome counts; the caller decides whether to log them.
 */
export async function idlePickupForAgent(
  deps: IdlePickupDeps,
  agent: { id: string; companyId: string },
  options: {
    excludeIssueId?: string | null;
    /**
     * myrmidon(TEAM-LIVENESS-SETTINGS): the caller's own decision for this agent
     * — the instance switch AND the agent card switch, already resolved. The
     * release path (heartbeat.ts) has the card at hand, so it does not make this
     * function read the settings row once per agent; the periodic sweep resolves
     * the pair once per pass and skips before it gets here. `undefined` keeps the
     * pre-settings behaviour: the environment decides.
     */
    behaviorEnabled?: boolean;
  } = {},
): Promise<IdlePickupResult> {
  const env = deps.env ?? process.env;
  // The caller's decision is the resolved pair (stored settings beat the
  // environment); only a caller that has none falls back to the environment.
  if (options.behaviorEnabled !== undefined) {
    if (!options.behaviorEnabled) return emptyIdlePickupResult();
  } else if (!readIdlePickupEnabled(env)) {
    return emptyIdlePickupResult();
  }

  // Succeeded runs matter only inside the recent-success window (see below), so
  // read just those: an unbounded read pulled every succeeded run of the agent
  // with its full context snapshot on every pickup pass (thousands of rows).
  const recentSuccessWindowMs = readIdlePickupRecentSuccessWindowMs(env);
  const recentSuccessCutoff = new Date(Date.now() - recentSuccessWindowMs);
  const [candidates, liveRuns] = await Promise.all([
    idlePickupCandidateRows(deps.db, agent.companyId, agent.id),
    deps.db
      .select({
        contextSnapshot: heartbeatRuns.contextSnapshot,
        status: heartbeatRuns.status,
        finishedAt: heartbeatRuns.finishedAt,
        startedAt: heartbeatRuns.startedAt,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, agent.companyId),
          eq(heartbeatRuns.agentId, agent.id),
          recentSuccessWindowMs > 0
            ? or(
                inArray(heartbeatRuns.status, [...LIVE_HEARTBEAT_RUN_STATUSES]),
                and(
                  eq(heartbeatRuns.status, "succeeded"),
                  sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) >= ${recentSuccessCutoff.toISOString()}::timestamptz`,
                ),
              )
            : inArray(heartbeatRuns.status, [...LIVE_HEARTBEAT_RUN_STATUSES]),
        ),
      ),
  ]);

  const result: IdlePickupResult = { ...emptyIdlePickupResult(), considered: candidates.length };
  if (candidates.length === 0) return result;

  const liveIssueIds = new Set(
    liveRuns
      .filter((run) => (LIVE_HEARTBEAT_RUN_STATUSES as readonly string[]).includes(run.status))
      .map((run) => readNonEmptyString(run.contextSnapshot?.issueId))
      .filter((id): id is string => Boolean(id)),
  );

  // A succeeded run that ended recently on an open issue is not idle work: the
  // vendor's successful-run-handoff / stranded-recovery machinery owns the next
  // step for exactly that shape (a disposition is missing, and those paths send
  // the instructive wake). Waking it again here only races them — and in tests
  // it turns one background run into a chain that leaks into the next suite.
  const recentlySucceededIssueIds = new Set(
    liveRuns
      .filter((run) => run.status === "succeeded")
      .map((run) => ({
        issueId: readNonEmptyString(run.contextSnapshot?.issueId),
        endedAt: run.finishedAt ?? run.startedAt ?? run.createdAt,
      }))
      .filter(
        (run): run is { issueId: string; endedAt: Date } =>
          Boolean(run.issueId) &&
          Date.now() - run.endedAt.getTime() < recentSuccessWindowMs,
      )
      .map((run) => run.issueId),
  );

  // Highest priority first, oldest blocked-transition breaks ties: the same
  // order the queued-run start path uses for one agent's runs.
  const ordered = orderIdlePickupCandidates(candidates);

  for (const candidate of ordered) {
    // The release path passes the issue whose execution was just released:
    // that issue is the agent's PAST work, not the next one. Waking it again
    // turns finish → wake → run → finish into a loop that never settles (the
    // vendor fixtures keep a finished issue in a wakeable status). Even when
    // the issue is legitimately still open (a run that ended without closing
    // it), one more immediate wake is exactly the runaway this guard stops;
    // the periodic sweep re-evaluates it on its own cadence with the
    // just-released exclusion no longer applying.
    if (options.excludeIssueId && candidate.id === options.excludeIssueId) {
      result.alreadyActive += 1;
      continue;
    }
    if (liveIssueIds.has(candidate.id)) {
      result.alreadyActive += 1;
      continue;
    }
    if (recentlySucceededIssueIds.has(candidate.id)) {
      // The issue just had a successful run without a disposition; the
      // successful-run-handoff / stranded-recovery paths own that next step.
      result.alreadyActive += 1;
      continue;
    }
    // A wake already covers this issue in any non-terminal status (queued,
    // deferred_issue_execution, claimed — not only "queued"): the admission
    // path owns it; a second wake would only coalesce into the first anyway.
    // A wake parked on an execution hold does not count (see hasCoveringWake).
    if (await hasCoveringWake(deps.db, agent, candidate.id)) {
      result.alreadyActive += 1;
      continue;
    }
    // myrmidon(IDLE-WAKE-BUDGET): the company-wide ceiling. The candidate above
    // passed every gate, so this is the moment a wake costs a full LLM session;
    // when the minute's budget is spent the pass stops here instead of scanning
    // the agent's remaining tasks. Nothing is dropped: the next window allows
    // again and the next pass re-reads the same candidate.
    if (deps.budget && !deps.budget.tryConsume(agent.companyId)) {
      result.budgetSkipped += 1;
      break;
    }

    const idempotencyKey = `${IDLE_WAKE_IDEMPOTENCY_PREFIX}:${candidate.id}`;
    try {
      const wake = await deps.enqueueWakeup(agent.id, {
        source: "automation",
        triggerDetail: "system",
        reason: IDLE_WAKE_REASON,
        idempotencyKey,
        requestedByActorType: "system",
        requestedByActorId: "idle_pickup",
        contextSnapshot: {
          issueId: candidate.id,
          taskKey: candidate.id,
          source: "idle_pickup",
        },
      });
      if (!wake) {
        // enqueueWakeup returns null for normal deferred/skipped paths (a
        // paused agent, admission limits, suppressed scheduling): the gates
        // did their job, this is not an error. The next tick retries.
        result.suppressed += 1;
        continue;
      }
      result.woken += 1;
      result.issueIds.push(candidate.id);
      await deps.logActivity?.({
        companyId: agent.companyId,
        actorType: "system",
        actorId: "idle_pickup",
        agentId: agent.id,
        runId: null,
        action: "issue.idle_pickup_wake_emitted",
        entityType: "issue",
        entityId: candidate.id,
        details: {
          identifier: candidate.identifier,
          priority: candidate.priority,
          idempotencyKey,
        },
      });
      return result;
    } catch (err) {
      // Best-effort: one issue that a concurrent wake, coalescing or an
      // execution blocker rejects is not a reason to fail the others.
      result.suppressed += 1;
      logger.warn(
        { err, agentId: agent.id, issueId: candidate.id },
        "idle-pickup wake failed for a ready assigned issue",
      );
      continue;
    }
  }
  return result;
}

/**
 * A wake already covers this issue in any non-terminal status (queued/deferred/claimed).
 *
 * myrmidon(HOLD-READY): except a deferred wake parked on an execution hold
 * (`payload.executionWait`). That wake is not in flight — it waits for a person
 * to lift the hold — so counting it as cover kept the issue out of every pass
 * for good once the hold was gone (the parked wake outlives the hold).
 */
async function hasCoveringWake(
  db: Db,
  agent: { id: string; companyId: string },
  issueId: string,
): Promise<boolean> {
  return db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, agent.companyId),
        eq(agentWakeupRequests.agentId, agent.id),
        inArray(agentWakeupRequests.status, [
          "queued",
          "deferred_issue_execution",
          "claimed",
        ]),
        sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
        wakeNotParkedOnExecutionHold(),
      ),
    )
    .limit(1)
    .then((rows) => Boolean(rows[0]));
}

/** Issue ids the agent currently has a live (queued/running/scheduled_retry) run for. */
async function loadAgentLiveIssueIds(
  db: Db,
  agent: { id: string; companyId: string },
): Promise<Set<string>> {
  const rows = await db
    .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, agent.companyId),
        eq(heartbeatRuns.agentId, agent.id),
        inArray(heartbeatRuns.status, [...LIVE_HEARTBEAT_RUN_STATUSES]),
      ),
    );
  return new Set(
    rows
      .map((run) => readNonEmptyString(run.contextSnapshot?.issueId))
      .filter((id): id is string => Boolean(id)),
  );
}

/**
 * The agent's top ready task — the same candidate set and candidate ranking the
 * idle-pickup scheduler uses — or null when the agent has none.
 *
 * The manual wake endpoint (WAKE-BIND) uses this so a wake without an explicit
 * issue can bind to the work the board would pick anyway, instead of producing
 * an issue-less run that cannot write to its task. Candidates already covered
 * by a live run or a pending wake are skipped: their next step belongs to the
 * in-flight work, and binding a fresh wake to them would only queue a duplicate
 * run on a task that is already being worked.
 */
export async function findTopReadyIssueForAgent(
  db: Db,
  agent: { id: string; companyId: string },
): Promise<IdlePickupIssueCandidate | null> {
  const candidates = await idlePickupCandidateRows(db, agent.companyId, agent.id);
  if (candidates.length === 0) return null;
  const liveIssueIds = await loadAgentLiveIssueIds(db, agent);
  for (const candidate of orderIdlePickupCandidates(candidates)) {
    if (liveIssueIds.has(candidate.id)) continue;
    if (await hasCoveringWake(db, agent, candidate.id)) continue;
    return candidate;
  }
  return null;
}

/**
 * The scheduler-tick pass: runs `idlePickupForAgent` for every invokable,
 * non-paused agent of every active company, at most once per
 * `MYRMIDON_IDLE_PICKUP_INTERVAL_SEC` seconds. The tick handler owns the
 * actual timer; this function only remembers when the last pass ran so the
 * caller can skip ticks inside the interval.
 */
export interface IdlePickupSweeper {
  sweep(now?: Date): Promise<IdlePickupSweepResult>;
  resetForTest(): void;
}

export interface IdlePickupSweepResult extends IdlePickupResult {
  agentsChecked: number;
  /**
   * Agents left for a later pass because their company had already received
   * this pass's batch (MYRMIDON_IDLE_PICKUP_WAKE_BATCH). The batch is what makes
   * the minute's wakes arrive in batches instead of one burst.
   */
  skippedOverBatch: number;
}

export interface IdlePickupSweeperDeps extends IdlePickupDeps {
  /** Invokability check for one agent (evaluateAgentInvokabilityFromDb): false for a paused agent. */
  isAgentInvokable: (agent: {
    id: string;
    companyId: string;
    name: string;
    reportsTo: string | null;
    status: string;
  }) => Promise<boolean>;
  /** Maintenance-mode gate (myrmidon R3): agents in a window are not woken. */
  isAgentUnderMaintenance: (agentId: string) => Promise<boolean>;
  /**
   * myrmidon(TEAM-LIVENESS-SETTINGS): the effective knobs, read once per pass so
   * a save on the instance settings page takes effect on the next pass without a
   * restart. Absent (unit tests that predate the settings area) means the
   * environment variables decide, exactly as before.
   */
  readLiveness?: () => Promise<ResolvedTeamLiveness>;
}

/** The agent row's card as a plain object; anything else reads as an empty card. */
function readAgentCard(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

export function createIdlePickupSweeper(deps: IdlePickupSweeperDeps): IdlePickupSweeper {
  let lastSweepAtMs = 0;
  return {
    resetForTest() {
      lastSweepAtMs = 0;
      deps.budget?.resetForTest();
    },
    async sweep(now = new Date()) {
      const env = deps.env ?? process.env;
      // myrmidon(TEAM-LIVENESS-SETTINGS): the stored instance settings win over
      // the environment; the reader already resolved that precedence per key.
      // Without a reader this module keeps reading the environment itself.
      const liveness = deps.readLiveness ? (await deps.readLiveness()).settings : null;
      const intervalMs =
        (liveness ? liveness.idlePickupIntervalSec : readIdlePickupIntervalSec(env)) * 1000;
      const enabled = liveness ? liveness.idlePickupEnabled : readIdlePickupEnabled(env);
      if (!enabled) {
        return { agentsChecked: 0, skippedOverBatch: 0, ...emptyIdlePickupResult() };
      }
      if (now.getTime() - lastSweepAtMs < intervalMs) {
        return { agentsChecked: 0, skippedOverBatch: 0, ...emptyIdlePickupResult() };
      }
      lastSweepAtMs = now.getTime();
      const envWake = readIdleWakeBudgetSettings(env);
      // A pass never spends more of the minute than the minute holds, whichever
      // layer set the two numbers.
      const perMinute = liveness ? liveness.idlePickupWakeBudgetPerMin : envWake.perMinute;
      const batch = Math.min(liveness ? liveness.idlePickupWakeBatch : envWake.batch, perMinute);
      // The release path spends the same budget object; handing it the resolved
      // pair keeps both paths on the numbers the operator saved.
      deps.budget?.configure({ perMinute, batch });

      const rows = await deps.db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          name: agents.name,
          reportsTo: agents.reportsTo,
          status: agents.status,
          adapterConfig: agents.adapterConfig,
        })
        .from(agents)
        .innerJoin(companies, eq(companies.id, agents.companyId))
        .where(eq(companies.status, "active"));

      const totals: IdlePickupResult = emptyIdlePickupResult();
      const wakesPerCompany = new Map<string, number>();
      let agentsChecked = 0;
      let skippedOverBatch = 0;
      for (const agent of rows) {
        // myrmidon(TEAM-LIVENESS-SETTINGS): this agent's own switch. A card that
        // turned the behaviour off is never woken by this pass; an absent switch
        // means the instance value applies.
        if (liveness && !resolveAgentTeamLiveness(readAgentCard(agent.adapterConfig), liveness).idlePickupEnabled) {
          continue;
        }
        // Invokability covers pause, termination and a broken reporting
        // chain; the maintenance gate covers the maintenance window. A wake
        // for a paused agent would be skipped by enqueueWakeup anyway, but
        // skipping earlier keeps the sweep off the admission path.
        if (!(await deps.isAgentInvokable(agent))) continue;
        if (await deps.isAgentUnderMaintenance(agent.id)) continue;
        // myrmidon(IDLE-WAKE-BUDGET): the batch cap. A company that already got
        // its batch this pass waits for the next one, so its minute allowance
        // arrives spread over passes; other companies in the same pass are not
        // delayed by it.
        if ((wakesPerCompany.get(agent.companyId) ?? 0) >= batch) {
          skippedOverBatch += 1;
          continue;
        }
        agentsChecked += 1;
        const perAgent = await idlePickupForAgent(deps, agent, {
          // The pass already decided with the resolved settings; handing the
          // decision over keeps the environment from vetoing a stored "on".
          behaviorEnabled: liveness ? true : undefined,
        });
        wakesPerCompany.set(
          agent.companyId,
          (wakesPerCompany.get(agent.companyId) ?? 0) + perAgent.woken,
        );
        totals.woken += perAgent.woken;
        totals.alreadyActive += perAgent.alreadyActive;
        totals.suppressed += perAgent.suppressed;
        totals.budgetSkipped += perAgent.budgetSkipped;
        totals.issueIds.push(...perAgent.issueIds);
      }
      if (totals.woken > 0) {
        logger.warn(
          { woken: totals.woken, issueIds: totals.issueIds, agentsChecked },
          "idle pickup woke ready assigned issues",
        );
      }
      return { agentsChecked, skippedOverBatch, ...totals };
    },
  };
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value;
}
