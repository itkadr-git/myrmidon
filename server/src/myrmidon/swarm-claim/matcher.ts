// server/src/myrmidon/swarm-claim/matcher.ts
//
// myrmidon(1.6.5 OPE-6608 A): the board-side matcher — a ready task meets a free
// agent of its caste in its nest without a run of the model in between
// (design.md §3).
//
// Why it exists. The 09.10 audit found 3259 `swarm_claim_queue` runs cancelled
// before their checkout over seven days and not one unassigned task claimed: the
// pass woke an agent with the id of a task that belonged to nobody, and the run
// admission dropped the run, because the task's assignee (NULL) was not the agent
// the run carried. The order is reversed here, once: the board pairs the two over
// SQL, the task becomes that agent's own (lease + assignee), and only then is that
// agent woken — with the task, never with "go and look for work".
//
// The rules (design §3.4), none of them negotiable:
//   * no rotation and no "fair" turn: the pick is the scent (T10); a full tie goes
//     to the smallest `agents.id` — deterministic, and meaningless for the
//     distribution, because the board sees every free agent at once;
//   * one task per agent per pass; the chosen agent leaves the pool;
//   * no free agent — the task waits and nobody is woken;
//   * a closed run admission field matches nothing at all: an assignment below the
//     floor only parks a run that waits in the queue and lets the lease expire for
//     nothing (design §3.4 п.5);
//   * the swarm switched off (design §5.1) matches nothing, and neither does a
//     caste the company's directory marks `swarmEligible: false` — checks made
//     here, before a lease is written, not on the run that follows.
//
// Ports keep the parts that are still landing elsewhere out of this file:
//   * T3 — the caste directory and the nests. Until T3 lands the pools are the
//     role reads of the queue (`listIdleRolePairs`): the caste of a task is its
//     `role:` label, else the company default, and every agent sits in the one nest
//     the company has today. `resolveTaskCaste`/`agentNests` are the seam T3 fills;
//     nothing else here changes then.
//   * T5 — `isIssueCoolingDown`: a task that just lost its owner waits out its
//     cooldown; absent, nothing cools down.
//   * T10 — `pickAgentForTask`: the scent pick; absent, every score is equal and
//     the tie goes to the smallest `agents.id`.

import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  companies,
  heartbeatRuns,
  issueClaims,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  SWARM_CLAIM_QUEUE_ISSUE_STATUSES,
  SWARM_CLAIM_WAKE_REASON,
  SWARM_MATCHED_ACTION,
  SWARM_MATCHED_CONTEXT_SOURCE,
  SWARM_MATCHED_MUTATION,
  SWARM_MATCHED_WAKE_REASON,
  orderSwarmQueueCandidates,
  resolveSwarmQueueEligibility,
  swarmActiveTaskLimitReached,
  swarmMatchedIdempotencyKey,
  swarmRoleForUnassignedTask,
  type SwarmClaimSettings,
} from "@paperclipai/shared";
import type { IssuePostCommitAction } from "../../services/issues.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "../../services/issue-assignment-wakeup.js";
import { logActivity as logActivityInTx, publishActivity, type ActivityPublication } from "../../services/activity-log.js";
import { issueHasNoExecutionHold } from "../settled-holds/ready-predicate.js";
import { isIssueCoolingDown } from "./cooling.js";
import { planClaim } from "./domain.js";
import { insertClaim, releaseClaimsForIssue, revertIdleClaimAssignment } from "./store.js";

/** One ready task, as the queue read offers it to the matcher. */
export interface SwarmMatcherTask {
  issueId: string;
  identifier: string | null;
  priority: string | null;
  role: string;
  queuedAt: Date | number | string | null;
}

/** One free agent, as the pool offers it. */
export interface SwarmMatcherAgent {
  agentId: string;
  role: string;
  /** Live leases the agent already holds, including the ceiling check. */
  activeClaims: number;
  /** The newest run of the agent; unused by the pick of today (T10 decides). */
  lastActiveAt: Date | null;
}

/** The pair the board made: the task is the agent's own from here on. */
export interface SwarmMatcherPair {
  issueId: string;
  agentId: string;
  role: string;
  identifier: string | null;
}

/** What one pass of the matcher did, so a caller can log or count it. */
export interface SwarmMatcherResult {
  pairs: SwarmMatcherPair[];
  /** Ready tasks a free agent was not found for in this pass. */
  unmatched: number;
  /** True when the host admission held the pass back (nothing was matched). */
  hostGateClosed: boolean;
}

/** The activity a match records (same shape the queue pass used). */
export interface SwarmMatcherActivity {
  companyId: string;
  actorType: "system";
  actorId: string;
  agentId: string;
  runId: string | null;
  action: string;
  entityType: "issue";
  entityId: string;
  details: Record<string, unknown>;
}

/**
 * The castes of a company, as much of the directory as the matcher reads (T3
 * brings the full one). Structurally the same shape the sweeper's `castes` port
 * hands over, so the port can be passed through without an adapter.
 */
export interface SwarmMatcherCaste {
  key: string;
  swarmEligible: boolean;
  maxActiveTasks: number | null;
}

/**
 * What the release path knows about the agent that just became free (review
 * item 1). All optional: an event that has none of it (a pause lifted, the
 * periodic pass) passes nothing and the agent's own tasks are all offered.
 */
export interface SwarmFreedAgentOptions {
  /** The task whose run just ended: past work, never offered back at once. */
  excludeIssueId?: string | null;
  /**
   * The resolved idle-pickup switch (instance AND the agent's own card). False
   * keeps the agent's own assigned tasks from being woken by this path.
   */
  pickupAllowed?: boolean;
  /** The company-wide wake allowance idle pickup spends (`tryConsume`). */
  wakeBudget?: { tryConsume(companyId: string): boolean };
}

export interface SwarmMatcherDeps {
  db: Db;
  /** The wake layer — the very one a manual assignment uses. */
  heartbeat: IssueAssignmentWakeupDeps;
  settings: SwarmClaimSettings;
  /** The run admission of the host at the moment of the pass (design §3.4 п.5). */
  hostGateOpen: boolean;
  /** The clock, injected so a test can drive the lease and a task's wait. */
  now: Date;
  /**
   * T3: the caste of a task. Absent, the queue read resolves it (`role:` label,
   * else the company default) — see the note at the top of this file.
   */
  resolveTaskCaste?: (input: { labels: readonly string[] | null }) => string;
  /**
   * The caste directory of the company (T3, the sweeper's `castes` port). A
   * caste the directory marks `swarmEligible: false` never enters the pools —
   * its ready tasks wait for a caste that is allowed to take them; a caste-set
   * ceiling overrides the global one for its agents only. A role the directory
   * does not carry stays in scope with the global ceiling: an empty directory
   * (or a company that never edited it) must not stop the swarm.
   */
  casteDirectory?: (companyId: string) => Promise<readonly SwarmMatcherCaste[]>;
  /** T3: the nests of an agent. Absent, every agent is in one nest. */
  agentNests?: (agentId: string) => Promise<readonly string[]>;
  /** T5: the cooldown of a task that just lost its owner. Absent, none. */
  isIssueCoolingDown?: (issueId: string) => Promise<boolean>;
  /** T10: the scent pick. Absent, equal scores and the tie by `agents.id`. */
  pickAgentForTask?: (
    task: SwarmMatcherTask,
    candidates: readonly SwarmMatcherAgent[],
  ) => SwarmMatcherAgent | null;
  logActivity?: (input: SwarmMatcherActivity) => Promise<void>;
}

/**
 * The pick of today (the T10 seam): every scent score is equal, so the tie is
 * resolved by the smallest `agents.id`. Written out rather than taken from the
 * read order, so a change of the read cannot change who gets the task.
 */
function pickBySmallestId(
  _task: SwarmMatcherTask,
  candidates: readonly SwarmMatcherAgent[],
): SwarmMatcherAgent | null {
  let best: SwarmMatcherAgent | null = null;
  for (const candidate of candidates) {
    if (best === null || candidate.agentId < best.agentId) best = candidate;
  }
  return best;
}

/**
 * The cooling of a task (design §4.3): the injected port (T5) when there is one,
 * else the board's own reading of the finished runs of the task. Never a stub:
 * a pass that cannot tell a cooling task from a ready one is the loop of the
 * review (a task that just failed is woken again the moment its run ends).
 */
function isCooling(deps: SwarmMatcherDeps, issueId: string): Promise<boolean> {
  return deps.isIssueCoolingDown
    ? deps.isIssueCoolingDown(issueId)
    : isIssueCoolingDown(deps.db, issueId, deps.now);
}

/**
 * The free agents of one role read (design §3.2): not paused, not in error, no
 * live run of its own, its own switch on, and under its ceiling. The ceiling is
 * the caste override where the read reports one and the global setting otherwise.
 */
function freeAgentsOfPair(
  pair: SwarmIdleRolePair,
  settings: SwarmClaimSettings,
  caste: SwarmMatcherCaste | null,
  opts: { ignoreLiveRun?: boolean } = {},
): SwarmMatcherAgent[] {
  // The ceiling of the caste wins over the global one (the same reading the
  // sweeper's idle pass used before this file took the pass over).
  const maxActiveTasks = caste?.maxActiveTasks ?? settings.maxActiveTasks;
  return pair.agents
    .filter((agent) => {
      if (
        agent.status === "paused" ||
        agent.status === "error" ||
        agent.status === "terminated"
      ) {
        return false;
      }
      if (agent.hasLiveRun && !opts.ignoreLiveRun) return false;
      // The agent's own switch, else the caste's `swarmEligible` (the directory
      // read below), else in scope. A caste the company switched off never
      // enters the pool: its ready tasks wait for a caste that may take them,
      // instead of being handed to an agent the claim gate will refuse.
      const queueEligible = resolveSwarmQueueEligibility({
        metadata: agent.metadata,
        casteEligible: caste?.swarmEligible ?? true,
      }).eligible;
      if (!queueEligible) return false;
      return !swarmActiveTaskLimitReached(agent.activeClaims, {
        maxActiveTasks,
      });
    })
    .map((agent) => ({
      agentId: agent.id,
      role: pair.role,
      activeClaims: agent.activeClaims,
      lastActiveAt: agent.lastActiveAt ?? null,
    }));
}

/** The wake that could not be queued took the assignment back with it. */
const SWARM_MATCHED_WAKE_FAILED_REASON = "swarm_matched_wake_failed";
/** The activity that records such a rollback, so the trace is not silent. */
const SWARM_MATCHED_ROLLED_BACK_ACTION = "issue.swarm_matched_rolled_back";

/** The task was taken (or left the queue) between the read and the write. */
class MatcherClaimLost extends Error {}

/** What one claim attempt came to. */
type ClaimOutcome = "claimed" | "lost" | "wake_failed";

/** A 4xx of the issues service (a task bound to a chat, an unassignable agent…) is a no, not a crash. */
function isClientRefusal(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500;
}

/**
 * The board's transaction (design §3.1), review item 5. One database
 * transaction holds the three writes — the task row is locked, the lease is
 * written (the partial unique index `issue_claims_issue_active_uq` closes the
 * race between two passes or two boards), and the task is assigned THROUGH the
 * issues service, so the assignment carries the same checks, the same
 * `issue.updated` activity and the same live event as a manual one. Only after
 * the commit is the new owner woken, through `queueIssueAssignmentWakeup`, the
 * same path a manual assignment takes, with `rethrowOnError`: a wake that
 * cannot be queued is not swallowed. Then the assignment is taken back and the
 * lease released — "assigned, leased, and no run" is the state this whole
 * rework exists to make impossible. (The wake is queued after the commit and not
 * inside it because the wake layer reads the committed task on its own
 * connection; inside the transaction it would see a task nobody owns.)
 */
async function claimTaskForAgent(
  deps: SwarmMatcherDeps,
  companyId: string,
  target: { issueId: string; agentId: string; role: string; identifier: string | null; waitedMs: number | null },
): Promise<ClaimOutcome> {
  const plan = planClaim({
    issueId: target.issueId,
    agentId: target.agentId,
    role: target.role,
    runId: null,
    now: deps.now,
    settings: { leaseTtlSec: deps.settings.leaseTtlSec },
  });
  const publications: ActivityPublication[] = [];
  const postCommitActions: IssuePostCommitAction[] = [];
  let status = "todo";
  try {
    await deps.db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const [row] = await txDb
        .select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId })
        .from(issues)
        .where(and(eq(issues.id, target.issueId), eq(issues.companyId, companyId)))
        .for("update");
      if (
        !row ||
        row.assigneeAgentId ||
        !(SWARM_CLAIM_QUEUE_ISSUE_STATUSES as readonly string[]).includes(row.status)
      ) {
        throw new MatcherClaimLost();
      }
      const claim = await insertClaim(txDb, { companyId, ...plan });
      if (!claim) throw new MatcherClaimLost();

      const { issueService } = await import("../../services/issues.js");
      const updated = await issueService(deps.db).update(
        target.issueId,
        { assigneeAgentId: target.agentId, companyGuard: companyId },
        txDb,
        publications,
        postCommitActions,
      );
      if (!updated) throw new MatcherClaimLost();

      await logActivityInTx(
        txDb,
        {
          companyId,
          actorType: "system",
          actorId: "swarm_matcher",
          agentId: target.agentId,
          action: "issue.updated",
          entityType: "issue",
          entityId: target.issueId,
          details: {
            assigneeAgentId: target.agentId,
            identifier: target.identifier,
            source: "swarm_matcher",
            changes: updated.changes,
            _previous: { assigneeAgentId: null },
          },
        },
        publications,
      );
      status = row.status;
    });
  } catch (err) {
    if (err instanceof MatcherClaimLost || isClientRefusal(err)) return "lost";
    throw err;
  }
  for (const publication of publications) publishActivity(publication);
  if (postCommitActions.length > 0) {
    const { executeIssuePostCommitActions } = await import("../../services/issues.js");
    await executeIssuePostCommitActions(deps.db, postCommitActions);
  }

  let woken: unknown = null;
  let wakeError: unknown = null;
  try {
    woken = await queueIssueAssignmentWakeup({
      heartbeat: deps.heartbeat,
      issue: { id: target.issueId, assigneeAgentId: target.agentId, status },
      reason: SWARM_MATCHED_WAKE_REASON,
      mutation: SWARM_MATCHED_MUTATION,
      contextSource: SWARM_MATCHED_CONTEXT_SOURCE,
      requestedByActorType: "system",
      idempotencyKey: swarmMatchedIdempotencyKey(target.issueId),
      rethrowOnError: true,
    });
  } catch (err) {
    wakeError = err;
  }
  if (!woken) {
    // No wake was queued (it threw, or the admission refused it): take the
    // assignment back and release the lease, so the task is back in the queue
    // untouched. Raw writes on purpose — a service update here would announce a
    // task event and send the matcher straight back to the same agent.
    await releaseClaimsForIssue(deps.db, {
      issueId: target.issueId,
      reason: SWARM_MATCHED_WAKE_FAILED_REASON,
      now: deps.now,
    });
    await revertIdleClaimAssignment(deps.db, {
      companyId,
      issueId: target.issueId,
      agentId: target.agentId,
      now: deps.now,
    });
    await deps.logActivity?.({
      companyId,
      actorType: "system",
      actorId: "swarm_matcher",
      agentId: target.agentId,
      runId: null,
      action: SWARM_MATCHED_ROLLED_BACK_ACTION,
      entityType: "issue",
      entityId: target.issueId,
      details: {
        role: target.role,
        identifier: target.identifier,
        reason: wakeError ? "wake_failed" : "wake_not_queued",
      },
    });
    return "wake_failed";
  }

  await deps.logActivity?.({
    companyId,
    actorType: "system",
    actorId: "swarm_matcher",
    agentId: target.agentId,
    runId: null,
    action: SWARM_MATCHED_ACTION,
    entityType: "issue",
    entityId: target.issueId,
    details: {
      role: target.role,
      identifier: target.identifier,
      waitedMs: target.waitedMs,
      // The moment, not the TTL: an auditor reads when the lease lapses.
      leaseExpiresAt: new Date(deps.now.getTime() + deps.settings.leaseTtlSec * 1000).toISOString(),
    },
  });

  return "claimed";
}

/** How long the task sat in the queue before the board handed it over. */
function waitedMsOf(task: SwarmMatcherTask, now: Date): number | null {
  const queuedAt = task.queuedAt;
  if (queuedAt === null || queuedAt === undefined) return null;
  const ms = queuedAt instanceof Date ? queuedAt.getTime() : typeof queuedAt === "number" ? queuedAt : Date.parse(queuedAt);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, now.getTime() - ms);
}

/**
 * The caste directory of a company, keyed by caste — read once per pass, the
 * same way the sweeper's idle pass reads it. Absent the port, no caste is
 * filtered and every pool keeps the global ceiling.
 */
async function casteDirectoryOf(
  deps: SwarmMatcherDeps,
  companyId: string,
): Promise<Map<string, SwarmMatcherCaste>> {
  const read = deps.casteDirectory;
  if (!read) return new Map();
  return new Map((await read(companyId)).map((entry) => [entry.key, entry]));
}

/**
 * One pass over a company (design §3.5, the safety net and the port `forCompany`
 * of the rework): the ready queue of every caste, in the order
 * `orderSwarmQueueCandidates` puts it (P0 → pheromone strength → age), each task
 * to a free agent of its caste in its nest, one task per agent. Nothing is woken
 * that no task was found for, and a closed host field matches nothing at all.
 */
export async function matchCompany(
  deps: SwarmMatcherDeps,
  companyId: string,
): Promise<SwarmMatcherResult> {
  const result: SwarmMatcherResult = { pairs: [], unmatched: 0, hostGateClosed: false };
  if (!deps.hostGateOpen) {
    result.hostGateClosed = true;
    return result;
  }
  // The switch of the whole swarm (design §5.1). Off, the board pairs nothing:
  // the ready queue waits and no lease is written that would then have to be
  // released — an operator must be able to stop the swarm without a restart.
  if (!deps.settings.enabled) return result;

  const castes = await casteDirectoryOf(deps, companyId);
  const pairs = await listIdleRolePairs(deps.db, companyId);
  for (const pair of pairs) {
    const caste = castes.get(pair.role) ?? null;
    if (caste && !caste.swarmEligible) continue;
    const queue = orderSwarmQueueCandidates(pair.queue, {
      p0Preemption: deps.settings.p0Preemption,
    });
    let free = freeAgentsOfPair(pair, deps.settings, caste);

    for (const candidate of queue) {
      if (candidate.assigneeAgentId) continue;
      if (await isCooling(deps, candidate.issueId)) {
        result.unmatched += 1;
        continue;
      }
      const task: SwarmMatcherTask = {
        issueId: candidate.issueId,
        identifier: candidate.identifier ?? null,
        priority: candidate.priority,
        role: pair.role,
        queuedAt: candidate.queuedAt,
      };
      const pick = deps.pickAgentForTask ?? pickBySmallestId;
      const chosen = pick(task, free);
      if (!chosen) {
        // The pick may refuse one task on its own terms (T10 reads the scent of
        // this very pair), so the pass goes on to the next candidate rather than
        // closing the queue: an empty pool refuses every later task anyway.
        result.unmatched += 1;
        continue;
      }

      const claimed = await claimTaskForAgent(deps, companyId, {
        issueId: candidate.issueId,
        agentId: chosen.agentId,
        role: pair.role,
        identifier: candidate.identifier ?? null,
        waitedMs: waitedMsOf(task, deps.now),
      });
      if (claimed !== "claimed") {
        result.unmatched += 1;
        // An agent that cannot be woken is not free for the rest of this pass.
        if (claimed === "wake_failed") {
          free = free.filter((agent) => agent.agentId !== chosen.agentId);
        }
        continue;
      }

      free = free.filter((agent) => agent.agentId !== chosen.agentId);
      result.pairs.push({
        issueId: candidate.issueId,
        agentId: chosen.agentId,
        role: pair.role,
        identifier: candidate.identifier ?? null,
      });
    }
  }

  return result;
}

/**
 * One task (design §3.5): the event "the task became ready and has no owner" —
 * created, unassigned, unblocked, released, its lease expired. The ready-queue
 * read is the authority on "ready"; this function only looks the task up in it,
 * so a task that is not ready (or is already somebody's) matches nothing.
 */
export async function matchIssue(
  deps: SwarmMatcherDeps,
  issueId: string,
): Promise<SwarmMatcherPair | null> {
  if (!deps.hostGateOpen) return null;
  if (!deps.settings.enabled) return null;
  const [row] = await deps.db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!row?.companyId) return null;
  if (row.assigneeAgentId) return null;
  if (!(SWARM_CLAIM_QUEUE_ISSUE_STATUSES as readonly string[]).includes(row.status)) return null;
  if (await isCooling(deps, issueId)) return null;

  const castes = await casteDirectoryOf(deps, row.companyId);
  const pairs = await listIdleRolePairs(deps.db, row.companyId);
  for (const pair of pairs) {
    const caste = castes.get(pair.role) ?? null;
    if (caste && !caste.swarmEligible) continue;
    const candidate = pair.queue.find((entry) => entry.issueId === issueId);
    if (!candidate || candidate.assigneeAgentId) continue;

    const task: SwarmMatcherTask = {
      issueId,
      identifier: candidate.identifier ?? null,
      priority: candidate.priority,
      role: pair.role,
      queuedAt: candidate.queuedAt,
    };
    const pick = deps.pickAgentForTask ?? pickBySmallestId;
    const chosen = pick(task, freeAgentsOfPair(pair, deps.settings, caste));
    if (!chosen) return null;

    const claimed = await claimTaskForAgent(deps, row.companyId, {
      issueId,
      agentId: chosen.agentId,
      role: pair.role,
      identifier: candidate.identifier ?? null,
      waitedMs: waitedMsOf(task, deps.now),
    });
    if (claimed !== "claimed") return null;
    return { issueId, agentId: chosen.agentId, role: pair.role, identifier: candidate.identifier ?? null };
  }
  return null;
}

/**
 * One agent (design §3.5): the event "the agent is free" — its run finished, its
 * pause was lifted, it was created. Its own assigned ready tasks come first (that
 * half stays with idle-pickup until design §3.6 hands it over); then a ready task
 * of its caste and nest becomes its own, so the agent is never woken empty.
 */
export async function matchAgent(
  deps: SwarmMatcherDeps,
  agentId: string,
  opts: SwarmFreedAgentOptions & { explicit?: boolean } = {},
): Promise<SwarmMatcherPair | null> {
  if (!deps.hostGateOpen) return null;
  if (!deps.settings.enabled) return null;
  const [agentRow] = await deps.db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      role: agents.role,
      status: agents.status,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!agentRow?.companyId) return null;
  if (agentRow.status === "paused" || agentRow.status === "terminated") return null;

  // The agent's own assigned ready task comes first (design §3.5 "своя
  // назначенная задача — первой"; review item 3). The queue read reports such
  // a task in the pair of the assignee's caste and only while nothing covers
  // it (no live lease, no wake in flight), so this wake is never a repeat and
  // the agent is never sent out to "look for work".
  // An explicit pull (the claim API) comes from a run that is already going:
  // its own assigned task is the run's business, not a reason to wake it.
  if (!opts.explicit) {
    const own = await matchOwnAssignedTask(deps, agentRow.companyId, agentId, opts);
    // The company's wake allowance for this minute is spent: the agent stays
    // idle until the next event or the periodic pass instead of being sent
    // somewhere else on the allowance it does not have.
    if (own === "budget_spent") return null;
    if (own) return own;
  }

  const castes = await casteDirectoryOf(deps, agentRow.companyId);
  const pairs = await listIdleRolePairs(deps.db, agentRow.companyId);
  const pair = pairs.find((entry) => entry.role === agentRow.role);
  if (!pair) return null;
  const caste = castes.get(pair.role) ?? null;
  // A caste the company switched off takes nothing, and neither does a task
  // routed to a caste no agent holds: the agent is simply not free for this
  // queue, so the event matches nothing (design §3.2).
  if (caste && !caste.swarmEligible) return null;
  if (
    !freeAgentsOfPair(pair, deps.settings, caste, { ignoreLiveRun: opts.explicit === true }).some(
      (agent) => agent.agentId === agentId,
    )
  ) {
    return null;
  }

  const queue = orderSwarmQueueCandidates(pair.queue, {
    p0Preemption: deps.settings.p0Preemption,
  });
  for (const candidate of queue) {
    if (candidate.assigneeAgentId) continue;
    if (await isCooling(deps, candidate.issueId)) continue;
    const task: SwarmMatcherTask = {
      issueId: candidate.issueId,
      identifier: candidate.identifier ?? null,
      priority: candidate.priority,
      role: pair.role,
      queuedAt: candidate.queuedAt,
    };
    const claimed = await claimTaskForAgent(deps, agentRow.companyId, {
      issueId: candidate.issueId,
      agentId,
      role: pair.role,
      identifier: candidate.identifier ?? null,
      waitedMs: waitedMsOf(task, deps.now),
    });
    // The agent could not be woken: another task would fail the same way.
    if (claimed === "wake_failed") return null;
    if (claimed !== "claimed") continue;
    return { issueId: candidate.issueId, agentId, role: pair.role, identifier: candidate.identifier ?? null };
  }
  return null;
}

/**
 * The agent's own assigned ready task, woken before any queue task (design
 * §3.5: "своя назначенная задача — первой"). Assigning only `assignee IS NULL`
 * tasks was a regression the first review caught: an agent holding an assigned,
 * unrun task was never woken for it again. No lease is written here: this task
 * is already the agent's own, the run that follows takes the lease on its
 * checkout the ordinary way.
 *
 * It is also the path of the loop the second review caught (design §4.3: 100
 * runs, 246 M tokens): the run ends, the task is still `todo` and still the
 * agent's, and the agent is woken for it again at once. Three guards close it,
 * the very ones idle-pickup had on this path:
 *   * the task whose run has just ended is never offered back (`excludeIssueId`);
 *   * the instance switch and the agent's own card switch of idle pickup
 *     (`pickupAllowed`) hold the wake back when the operator turned it off;
 *   * a task that is cooling down (its last runs moved nothing) waits, and the
 *     company's wake allowance (`wakeBudget`, the very object idle pickup
 *     spends) is taken before the wake.
 * Returns `"budget_spent"` when only the allowance stopped the wake, so the
 * caller does not turn to the queue on an allowance it has not got.
 */
async function matchOwnAssignedTask(
  deps: SwarmMatcherDeps,
  companyId: string,
  agentId: string,
  options: SwarmFreedAgentOptions,
): Promise<SwarmMatcherPair | "budget_spent" | null> {
  if (options.pickupAllowed === false) return null;
  const pairs = await listIdleRolePairs(deps.db, companyId);
  for (const pair of pairs) {
    const own = orderSwarmQueueCandidates(pair.queue, {
      p0Preemption: deps.settings.p0Preemption,
    }).filter((entry) => entry.assigneeAgentId === agentId);
    for (const candidate of own) {
      if (options.excludeIssueId && candidate.issueId === options.excludeIssueId) continue;
      if (await isCooling(deps, candidate.issueId)) continue;
      if (options.wakeBudget && !options.wakeBudget.tryConsume(companyId)) return "budget_spent";
      const woken = await queueIssueAssignmentWakeup({
        heartbeat: deps.heartbeat,
        issue: { id: candidate.issueId, assigneeAgentId: agentId, status: "todo" },
        reason: SWARM_MATCHED_WAKE_REASON,
        mutation: SWARM_MATCHED_MUTATION,
        contextSource: SWARM_MATCHED_CONTEXT_SOURCE,
        requestedByActorType: "system",
        idempotencyKey: swarmMatchedIdempotencyKey(candidate.issueId),
      });
      // A wake the admission refused started nothing: no pair, no activity.
      if (!woken) continue;
      await deps.logActivity?.({
        companyId,
        actorType: "system",
        actorId: "swarm_matcher",
        agentId,
        runId: null,
        action: SWARM_MATCHED_ACTION,
        entityType: "issue",
        entityId: candidate.issueId,
        details: { role: pair.role, identifier: candidate.identifier ?? null, ownTask: true },
      });
      return {
        issueId: candidate.issueId,
        agentId,
        role: pair.role,
        identifier: candidate.identifier ?? null,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The ready-queue read (review item 5). It lived in `idle-queue.ts`, the module
// of the retired idle-wake batch; the matcher is the only consumer left and the
// two pool reads of design §3.2/§3.3 belong to the file that owns the pass, so
// the read moved here and that module is gone.
// ---------------------------------------------------------------------------

/** One queue entry: an unassigned task, or one that already has an owner. */
export interface SwarmMatcherQueueCandidate {
  issueId: string;
  identifier?: string | null;
  priority: string | null;
  /** Tie-break: the older the task entered the queue, the earlier it ranks. */
  queuedAt: Date | number | string | null;
  assigneeAgentId?: string | null;
}

const LIVE_HEARTBEAT_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;

/** The read-ready pairs of one company: the queue of each caste + its agents' idle state. */
export interface SwarmIdleRolePair {
  role: string;
  companyId: string;
  queue: SwarmMatcherQueueCandidate[];
  agents: {
    id: string;
    status: string | null;
    activeClaims: number;
    hasLiveRun: boolean;
    /** 1.6.5 (OPE-6608 C): `agents.metadata`, the carrier of the agent's own queue switch. */
    metadata?: Record<string, unknown> | null;
    /** 1.6.5 (OPE-6608 B): the agent's newest run, for the fair order. */
    lastActiveAt: Date | null;
  }[];
}

/**
 * Every caste of a company that has at least one ready queue candidate and
 * every agent of that caste, with its live-claim count. The per-agent ceiling
 * is NOT applied here (it can be caste-overridden per agent); the pool policy
 * above decides freeness.
 */
export async function listIdleRolePairs(
  db: Db,
  companyId: string,
): Promise<SwarmIdleRolePair[]> {
  const [queueRows, agentRows, liveRunAgentIds, lastRunRows, activeClaimCounts] =
    await Promise.all([
      listReadyQueueCandidates(db, companyId),
      db
        .select({
          id: agents.id,
          role: agents.role,
          status: agents.status,
          metadata: agents.metadata,
        })
        .from(agents)
        .innerJoin(companies, eq(companies.id, agents.companyId))
        .where(and(eq(agents.companyId, companyId), eq(companies.status, "active")))
        // A stable order of the pool. Two passes over equal facts see the same
        // rows in the same order; the pick itself is the scent (T10).
        .orderBy(asc(agents.id)),
      db
        .select({ agentId: heartbeatRuns.agentId })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            inArray(heartbeatRuns.status, [...LIVE_HEARTBEAT_RUN_STATUSES]),
          ),
        ),
      db
        .select({
          agentId: heartbeatRuns.agentId,
          lastActiveAt: sql<Date | string | null>`max(${heartbeatRuns.createdAt})`,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, companyId))
        .groupBy(heartbeatRuns.agentId),
      // The live leases of the company, per agent. The per-agent ceiling needs
      // them: an agent that already holds a lease is not a free agent, and a
      // hardcoded zero here would hand it a second task it cannot start.
      liveClaimCountsByAgent(db, companyId),
    ] as const);

  const liveRuns = new Set(
    liveRunAgentIds.map((row: { agentId: string }) => row.agentId),
  );
  const lastActive = new Map<string, Date | null>();
  for (const row of lastRunRows as Array<{ agentId: string; lastActiveAt: Date | string | null }>) {
    lastActive.set(row.agentId, row.lastActiveAt ? new Date(row.lastActiveAt) : null);
  }
  const byRole = new Map<string, SwarmMatcherQueueCandidate[]>();
  for (const row of queueRows) {
    const roles = rolesOfQueueRow(row);
    for (const role of roles) {
      const list = byRole.get(role) ?? [];
      if (list.length < 200) list.push(row.candidate);
      byRole.set(role, list);
    }
  }

  const pairs: SwarmIdleRolePair[] = [];
  for (const [role, queue] of byRole) {
    if (queue.length === 0) continue;
    const roleAgents = agentRows
      .filter((agent) => agent.role === role)
      .map((agent) => ({
        id: agent.id,
        status: agent.status,
        activeClaims: activeClaimCounts.get(agent.id) ?? 0,
        hasLiveRun: liveRuns.has(agent.id),
        metadata: (agent.metadata as Record<string, unknown> | null) ?? null,
        lastActiveAt: lastActive.get(agent.id) ?? null,
      }));
    // A caste with no agents at all still reports the pair (the supervisor
    // metric counts it), but the pool wakes no one.
    pairs.push({ role, companyId, queue, agents: roleAgents });
  }
  return pairs;
}

/** The live (not released) claim counts per agent of one company. */
export async function liveClaimCountsByAgent(
  db: Db,
  companyId: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({ agentId: issueClaims.agentId })
    .from(issueClaims)
    .where(and(eq(issueClaims.companyId, companyId), isNull(issueClaims.releasedAt)));
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.agentId, (counts.get(row.agentId) ?? 0) + 1);
  }
  return counts;
}

/** One raw ready queue row with the castes it belongs to. */
interface ReadyQueueRow {
  candidate: SwarmMatcherQueueCandidate;
  assigneeAgentId: string | null;
  assigneeRole: string | null;
  /** Lower-cased names of the issue's labels (the `role:<key>` tag lives here). */
  labels: string[];
}

/** The ready queue of a company (both assigned-to-caste and unassigned rows). */
async function listReadyQueueCandidates(db: Db, companyId: string) {
  const rows = await db
    .select({
      issueId: issues.id,
      identifier: issues.identifier,
      priority: issues.priority,
      queuedAt: issues.createdAt,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeRole: agents.role,
      labels: sql<string[]>`coalesce((
        select array_agg(lower(btrim(l.name)))
        from issue_labels il
          join labels l on l.id = il.label_id
        where il.issue_id = ${issues.id}
      ), array[]::text[])`,
    })
    .from(issues)
    .leftJoin(agents, eq(agents.id, issues.assigneeAgentId))
    .where(
      and(
        eq(issues.companyId, companyId),
        isNull(issues.assigneeUserId),
        isNull(issues.hiddenAt),
        isNull(issues.conversationAgentId),
        inArray(issues.status, [...SWARM_CLAIM_QUEUE_ISSUE_STATUSES]),
        // The readiness filters of idle-pickup: no open blocker, not a plan
        // container, not mid-decomposition. Ready means one thing everywhere.
        sql`not exists (
          select 1
          from issue_relations ir
            join issues blocker on blocker.id = ir.issue_id and blocker.company_id = ${issues.companyId}
          where ir.company_id = ${issues.companyId}
            and ir.related_issue_id = ${issues.id}
            and ir.type = 'blocks'
            and blocker.status <> 'done'
        )`,
        sql`not exists (
          select 1
          from issues child
          where child.company_id = ${issues.companyId}
            and child.parent_id = ${issues.id}
            and child.status not in ('done', 'cancelled')
        )`,
        sql`not exists (
          select 1
          from issue_plan_decompositions decomp
          where decomp.company_id = ${issues.companyId}
            and decomp.source_issue_id = ${issues.id}
            and decomp.status = 'in_flight'
        )`,
        // myrmidon(HOLD-READY): not held by an execution hold (see idle-pickup.ts).
        issueHasNoExecutionHold(db),
        // A task that is already covered — a live lease, or a wake in flight
        // (not parked on a hold) — is being worked on and is not a queue
        // candidate; the pool is what is genuinely waiting.
        sql`not exists (
          select 1 from issue_claims ic
          where ic.issue_id = ${issues.id} and ic.released_at is null
        )`,
        sql`not exists (
          select 1 from agent_wakeup_requests w
          where w.company_id = ${issues.companyId}
            and w.status in ('queued', 'deferred_issue_execution', 'claimed')
            and w.payload ->> 'issueId' = ${issues.id}::text
            and not (
              w.status = 'deferred_issue_execution'
              and coalesce(jsonb_typeof(w.payload -> 'executionWait'), 'null') = 'object'
            )
        )`,
      ),
    )
    .orderBy(asc(issues.createdAt))
    .limit(500);
  return rows.map((row): ReadyQueueRow => ({
    candidate: {
      issueId: row.issueId,
      identifier: row.identifier,
      priority: row.priority,
      queuedAt: row.queuedAt,
      assigneeAgentId: row.assigneeAgentId,
    },
    assigneeAgentId: row.assigneeAgentId,
    assigneeRole: row.assigneeRole ?? null,
    labels: row.labels ?? [],
  }));
}

/**
 * Which caste queue a ready row belongs to. An assigned task queues for its
 * assignee's caste (and, in the pass, for that agent alone); an unassigned task
 * queues for the one caste its `role:<key>` label names, the project default
 * when it has none. A caste with no agents still gets its pair, so the sweep
 * can report "ready work, nobody of the caste exists" instead of idling
 * silently.
 */
export function rolesOfQueueRow(row: ReadyQueueRow): string[] {
  if (row.assigneeAgentId) {
    return row.assigneeRole ? [row.assigneeRole] : [];
  }
  return [swarmRoleForUnassignedTask(row.labels)];
}

/**
 * 1.6.5 (OPE-6608 D): the live counters the swarm panel shows — how much ready
 * work is waiting, how much the queues took in the last hour, and how many of
 * their wakes died in that hour. The third number is the one that exposed the
 * bug this ticket fixes (3259 cancelled wakes, 0 claims), so it belongs on the
 * panel an operator can watch after a roll-out.
 */
export interface SwarmQueueCounters {
  queuedUnassigned: number;
  claimedLastHour: number;
  cancelledLastHour: number;
}

export async function readSwarmQueueCounters(
  db: Db,
  input: { companyIds: readonly string[] | null; now: Date },
): Promise<SwarmQueueCounters> {
  const since = new Date(input.now.getTime() - 60 * 60 * 1000);
  const companyIds =
    input.companyIds && input.companyIds.length > 0
      ? [...input.companyIds]
      : (
          await db
            .select({ id: companies.id })
            .from(companies)
            .where(inArray(companies.status, ["active"]))
        ).map((row) => row.id);

  const perCompany = await Promise.all(
    companyIds.map(async (companyId) => {
      const [queueRows, claimedRows, cancelledRows] = await Promise.all([
        listReadyQueueCandidates(db, companyId),
        db
          .select({ id: issueClaims.id })
          .from(issueClaims)
          .where(and(eq(issueClaims.companyId, companyId), gte(issueClaims.claimedAt, since))),
        db
          .select({ id: agentWakeupRequests.id })
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, companyId),
              inArray(agentWakeupRequests.reason, [SWARM_CLAIM_WAKE_REASON, SWARM_MATCHED_WAKE_REASON]),
              inArray(agentWakeupRequests.status, ["skipped", "cancelled", "failed"]),
              gte(agentWakeupRequests.requestedAt, since),
            ),
          ),
      ]);
      return {
        queuedUnassigned: queueRows.filter((row) => row.assigneeAgentId === null).length,
        claimedLastHour: claimedRows.length,
        cancelledLastHour: cancelledRows.length,
      } satisfies SwarmQueueCounters;
    }),
  );

  return perCompany.reduce<SwarmQueueCounters>(
    (total, counts) => ({
      queuedUnassigned: total.queuedUnassigned + counts.queuedUnassigned,
      claimedLastHour: total.claimedLastHour + counts.claimedLastHour,
      cancelledLastHour: total.cancelledLastHour + counts.cancelledLastHour,
    }),
    { queuedUnassigned: 0, claimedLastHour: 0, cancelledLastHour: 0 },
  );
}