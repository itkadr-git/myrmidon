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
//     nothing (design §3.4 п.5).
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

import { eq } from "drizzle-orm";
import { agents, issues, type Db } from "@paperclipai/db";
import {
  SWARM_CLAIM_QUEUE_ISSUE_STATUSES,
  SWARM_MATCHED_ACTION,
  SWARM_MATCHED_ASSIGNMENT_LOST_REASON,
  SWARM_MATCHED_CONTEXT_SOURCE,
  SWARM_MATCHED_MUTATION,
  SWARM_MATCHED_WAKE_REASON,
  orderSwarmQueueCandidates,
  resolveSwarmQueueEligibility,
  swarmActiveTaskLimitReached,
  swarmMatchedIdempotencyKey,
  type SwarmClaimSettings,
} from "@paperclipai/shared";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "../../services/issue-assignment-wakeup.js";
import { planClaim } from "./domain.js";
import { listIdleRolePairs, type SwarmIdleRolePair } from "./idle-queue.js";
import {
  assignIssueToAgentForIdleClaim,
  insertClaim,
  releaseClaimsForIssue,
} from "./store.js";

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
 * The free agents of one role read (design §3.2): not paused, not in error, no
 * live run of its own, its own switch on, and under its ceiling. The ceiling is
 * the caste override where the read reports one and the global setting otherwise.
 */
function freeAgentsOfPair(
  pair: SwarmIdleRolePair,
  settings: SwarmClaimSettings,
): SwarmMatcherAgent[] {
  return pair.agents
    .filter((agent) => {
      if (
        agent.status === "paused" ||
        agent.status === "error" ||
        agent.status === "terminated"
      ) {
        return false;
      }
      if (agent.hasLiveRun) return false;
      // The agent's own switch (design §3.2). The caste half is `true` until T3
      // brings the directory: the read reports the agent, the policy decides.
      const queueEligible = resolveSwarmQueueEligibility({
        metadata: agent.metadata,
        casteEligible: true,
        hasDirectReports: agent.hasDirectReports,
      }).eligible;
      if (!queueEligible) return false;
      return !swarmActiveTaskLimitReached(agent.activeClaims, {
        maxActiveTasks: settings.maxActiveTasks,
      });
    })
    .map((agent) => ({
      agentId: agent.id,
      role: pair.role,
      activeClaims: agent.activeClaims,
      lastActiveAt: agent.lastActiveAt ?? null,
    }));
}

/**
 * The board's transaction (design §3.1): the lease first — the partial unique
 * index `issue_claims_issue_active_uq` is what closes the race between two passes
 * or two boards — then the task's assignee, then the wake of its new owner. The
 * wake goes through `queueIssueAssignmentWakeup`, the same path a manual
 * assignment takes, so the vendor mechanics that follow (auto-checkout, ownership,
 * the lease pickup on checkout) all see a task that already has an owner.
 */
async function claimTaskForAgent(
  deps: SwarmMatcherDeps,
  companyId: string,
  target: { issueId: string; agentId: string; role: string; identifier: string | null; waitedMs: number | null },
): Promise<boolean> {
  const plan = planClaim({
    issueId: target.issueId,
    agentId: target.agentId,
    role: target.role,
    runId: null,
    now: deps.now,
    settings: { leaseTtlSec: deps.settings.leaseTtlSec },
  });
  const claim = await insertClaim(deps.db, { companyId, ...plan });
  if (!claim) return false;

  const assigned = await assignIssueToAgentForIdleClaim(deps.db, {
    companyId,
    issueId: target.issueId,
    agentId: target.agentId,
    now: deps.now,
  });
  if (!assigned) {
    // Somebody else took the task between the lease and the assignee: drop the
    // lease at once, so the next pass is not blocked by a trace of this one.
    await releaseClaimsForIssue(deps.db, {
      issueId: target.issueId,
      reason: SWARM_MATCHED_ASSIGNMENT_LOST_REASON,
      now: deps.now,
    });
    return false;
  }

  await queueIssueAssignmentWakeup({
    heartbeat: deps.heartbeat,
    issue: { id: target.issueId, assigneeAgentId: target.agentId, status: "todo" },
    reason: SWARM_MATCHED_WAKE_REASON,
    mutation: SWARM_MATCHED_MUTATION,
    contextSource: SWARM_MATCHED_CONTEXT_SOURCE,
    requestedByActorType: "system",
    idempotencyKey: swarmMatchedIdempotencyKey(target.issueId),
  });

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
      leaseExpiresAt: deps.settings.leaseTtlSec,
    },
  });

  return true;
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

  const pairs = await listIdleRolePairs(deps.db, companyId);
  for (const pair of pairs) {
    const queue = orderSwarmQueueCandidates(pair.queue, {
      p0Preemption: deps.settings.p0Preemption,
    });
    let free = freeAgentsOfPair(pair, deps.settings);

    for (const candidate of queue) {
      if (candidate.assigneeAgentId) continue;
      if (await deps.isIssueCoolingDown?.(candidate.issueId)) {
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
        result.unmatched += 1;
        break;
      }

      const claimed = await claimTaskForAgent(deps, companyId, {
        issueId: candidate.issueId,
        agentId: chosen.agentId,
        role: pair.role,
        identifier: candidate.identifier ?? null,
        waitedMs: waitedMsOf(task, deps.now),
      });
      if (!claimed) {
        result.unmatched += 1;
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
  if (await deps.isIssueCoolingDown?.(issueId)) return null;

  const pairs = await listIdleRolePairs(deps.db, row.companyId);
  for (const pair of pairs) {
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
    const chosen = pick(task, freeAgentsOfPair(pair, deps.settings));
    if (!chosen) return null;

    const claimed = await claimTaskForAgent(deps, row.companyId, {
      issueId,
      agentId: chosen.agentId,
      role: pair.role,
      identifier: candidate.identifier ?? null,
      waitedMs: waitedMsOf(task, deps.now),
    });
    if (!claimed) return null;
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
): Promise<SwarmMatcherPair | null> {
  if (!deps.hostGateOpen) return null;
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

  const pairs = await listIdleRolePairs(deps.db, agentRow.companyId);
  const pair = pairs.find((entry) => entry.role === agentRow.role);
  if (!pair) return null;
  if (!freeAgentsOfPair(pair, deps.settings).some((agent) => agent.agentId === agentId)) return null;

  const queue = orderSwarmQueueCandidates(pair.queue, {
    p0Preemption: deps.settings.p0Preemption,
  });
  for (const candidate of queue) {
    if (candidate.assigneeAgentId) continue;
    if (await deps.isIssueCoolingDown?.(candidate.issueId)) continue;
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
    if (!claimed) continue;
    return { issueId: candidate.issueId, agentId, role: pair.role, identifier: candidate.identifier ?? null };
  }
  return null;
}