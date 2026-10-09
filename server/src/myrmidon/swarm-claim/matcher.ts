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
// What the matcher does NOT implement itself — one rule each, owned elsewhere:
//   * the queue order and the routing (F-27, #1047): a caste's pool is read by
//     `listIdleRolePairs` with the queue reads' own SQL — the caste of an
//     unassigned task is `unassignedTaskRoutedToRole` (the task's caste, else the
//     project default, else the legacy `role:` label, else the default role), the
//     order is `swarmQueueOrderBy` (P0 → effective pheromone → age → id) over the
//     `failedRunsDerivedSql` join. The matcher walks the rows in that order and
//     never re-sorts them;
//   * the cooling (F-26 T5, #1070): `isIssueCoolingDown` of wake-task-guard.ts,
//     through the adapter in ./cooling.ts; the `isIssueCoolingDown` port of the
//     deps replaces it in a test;
//   * T10 — `pickAgentForTask`: the scent pick; absent, every score is equal and
//     the tie goes to the smallest `agents.id`.

import { and, asc, count, eq, gte, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
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
  pheromoneDynamicsOf,
  resolveSwarmQueueEligibility,
  swarmActiveTaskLimitReached,
  swarmMatchedIdempotencyKey,
  type SwarmClaimSettings,
  type SwarmSettings,
} from "@paperclipai/shared";
import type { IssuePostCommitAction } from "../../services/issues.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "../../services/issue-assignment-wakeup.js";
import { logActivity as logActivityInTx, publishActivity, type ActivityPublication } from "../../services/activity-log.js";
import { issueHasNoExecutionHold } from "../settled-holds/ready-predicate.js";
import { evaluateAgentInvokability, evaluateAgentInvokabilityFromDb } from "../../services/agent-invokability.js";
import { swarmAgentAvailability, type SwarmAgentAvailability } from "./availability.js";
import { readSwarmCoolingSettings, swarmTaskCoolingDown, type SwarmCoolingSettings } from "./cooling.js";
import { planClaim } from "./domain.js";
import {
  failedRunsDerivedSql,
  failedRunsJoinOnSql,
  failedRunsSinceLastChangeSql,
  swarmQueueOrderBy,
  type SwarmQueueOrderOptions,
} from "./effective-pheromone.js";
import { unassignedTaskRoutedToRole } from "./queue.js";
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
  /**
   * The cooling of a task, as a test drives it. Absent, the product's one rule
   * decides: `isIssueCoolingDown` of wake-task-guard.ts (F-26 T5), through the
   * adapter in ./cooling.ts.
   */
  isIssueCoolingDown?: (issueId: string) => Promise<boolean>;
  /**
   * The cooling settings of the pass (`general.swarm`: base and ceiling of the
   * window). Absent, the adapter reads them once per call (`readSwarmSettings`).
   */
  coolingSettings?: Pick<SwarmSettings, "cooldownBaseMin" | "cooldownCeilingHours">;
  /**
   * Whether a wake of the agent would pass the gates of the wake layer beyond
   * its own invokability (design §3.2): the maintenance window and the budget
   * block. Absent, `swarmAgentAvailability(db)` reads them; a test replaces it.
   */
  isAgentAvailable?: SwarmAgentAvailability;
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
 * The cooling of a task (design §4.3): the injected port when a test gives one,
 * else the product's single rule (`isIssueCoolingDown`, wake-task-guard.ts)
 * through the swarm-claim adapter. The matcher keeps no cooling rule of its own.
 */
async function isCooling(deps: SwarmMatcherDeps, companyId: string, issueId: string): Promise<boolean> {
  if (deps.isIssueCoolingDown) return deps.isIssueCoolingDown(issueId);
  return swarmTaskCoolingDown(deps.db, {
    companyId,
    issueId,
    now: deps.now,
    settings: await coolingSettingsOf(deps),
  });
}

/** One settings read per pass (the deps object is the pass), not one per task. */
const coolingSettingsByPass = new WeakMap<SwarmMatcherDeps, Promise<SwarmCoolingSettings>>();

function coolingSettingsOf(deps: SwarmMatcherDeps): Promise<SwarmCoolingSettings> {
  if (deps.coolingSettings) return Promise.resolve(deps.coolingSettings);
  let read = coolingSettingsByPass.get(deps);
  if (!read) {
    read = readSwarmCoolingSettings(deps.db);
    coolingSettingsByPass.set(deps, read);
  }
  return read;
}

/**
 * The order options of the queue reads of one pass: the P0 switch and the
 * effective-strength knobs of the `pheromone` settings, at the pass clock — the
 * same three the claim API and the supervisor view hand to `swarmQueueOrderBy`.
 */
/** One availability reading per agent per pass (the deps object is the pass). */
const availabilityByPass = new WeakMap<SwarmMatcherDeps, Map<string, Promise<boolean>>>();
const defaultAvailabilityByDb = new WeakMap<object, SwarmAgentAvailability>();

function isAvailable(deps: SwarmMatcherDeps, companyId: string, agentId: string): Promise<boolean> {
  let seen = availabilityByPass.get(deps);
  if (!seen) {
    seen = new Map();
    availabilityByPass.set(deps, seen);
  }
  let answer = seen.get(agentId);
  if (!answer) {
    let read = deps.isAgentAvailable;
    if (!read) {
      read = defaultAvailabilityByDb.get(deps.db as object);
      if (!read) {
        read = swarmAgentAvailability(deps.db);
        defaultAvailabilityByDb.set(deps.db as object, read);
      }
    }
    answer = read({ agentId, companyId });
    seen.set(agentId, answer);
  }
  return answer;
}

/** The free agents of a pool that the wake layer will also accept (design §3.2). */
async function availableAgents(
  deps: SwarmMatcherDeps,
  companyId: string,
  free: readonly SwarmMatcherAgent[],
): Promise<SwarmMatcherAgent[]> {
  const out: SwarmMatcherAgent[] = [];
  for (const agent of free) {
    if (await isAvailable(deps, companyId, agent.agentId)) out.push(agent);
  }
  return out;
}

/**
 * Pair one task with the pool: the pick, the claim, and on a wake the layer
 * refused the NEXT agent of the pool for the same task (ADM review of
 * 18a69ff91: one agent that cannot be woken must not starve the task). Returns
 * the pair, `"lost"` when the task itself is gone, or null when no agent of the
 * pool took it. Every agent whose wake failed leaves `failed` for the pass.
 */
async function pairTaskWithPool(
  deps: SwarmMatcherDeps,
  companyId: string,
  task: SwarmMatcherTask,
  pool: readonly SwarmMatcherAgent[],
  failed: Set<string>,
): Promise<SwarmMatcherAgent | "lost" | null> {
  const pick = deps.pickAgentForTask ?? pickBySmallestId;
  let candidates = pool.filter((agent) => !failed.has(agent.agentId));
  while (candidates.length > 0) {
    const chosen = pick(task, candidates);
    if (!chosen) return null;
    const claimed = await claimTaskForAgent(deps, companyId, {
      issueId: task.issueId,
      agentId: chosen.agentId,
      role: task.role,
      identifier: task.identifier,
      waitedMs: waitedMsOf(task, deps.now),
    });
    if (claimed === "claimed") return chosen;
    if (claimed === "lost") return "lost";
    failed.add(chosen.agentId);
    candidates = candidates.filter((agent) => agent.agentId !== chosen.agentId);
  }
  return null;
}

function queueOrderOf(deps: SwarmMatcherDeps): SwarmQueueOrderOptions {
  return {
    p0Preemption: deps.settings.p0Preemption,
    dynamics: pheromoneDynamicsOf(deps.settings.pheromone),
    now: deps.now,
  };
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
      // The vendor invokability (pending approval, a terminated manager, a
      // reporting cycle…): the wake layer refuses such an agent, so it is not
      // free work — the pass would pair, fail the wake and roll back forever.
      if (agent.invokable === false) return false;
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
 * of the rework): the ready queue of every caste, in the queue order of the reads
 * (`swarmQueueOrderBy`: P0 → effective pheromone → age → id), each task
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
  const pairs = await listIdleRolePairs(deps.db, companyId, { order: queueOrderOf(deps) });
  for (const pair of pairs) {
    const caste = castes.get(pair.role) ?? null;
    if (caste && !caste.swarmEligible) continue;
    let free = await availableAgents(deps, companyId, freeAgentsOfPair(pair, deps.settings, caste));
    const failed = new Set<string>();

    // The pool read is already in the queue order (`swarmQueueOrderBy`).
    const open = pair.queue.filter((candidate) => !candidate.assigneeAgentId);
    for (let index = 0; index < open.length; index += 1) {
      const candidate = open[index]!;
      // Nobody left to take anything: the rest of the caste's queue waits.
      // No cooling read for tasks that could not be handed out anyway.
      if (free.length === 0) {
        result.unmatched += open.length - index;
        break;
      }
      if (await isCooling(deps, companyId, candidate.issueId)) {
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
      // The pick may refuse one task on its own terms (T10 reads the scent of
      // this very pair), so the pass goes on to the next candidate rather than
      // closing the queue.
      const chosen = await pairTaskWithPool(deps, companyId, task, free, failed);
      // An agent whose wake failed is not free for the rest of this pass.
      free = free.filter((agent) => !failed.has(agent.agentId));
      if (!chosen || chosen === "lost") {
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
  if (await isCooling(deps, row.companyId, issueId)) return null;

  const castes = await casteDirectoryOf(deps, row.companyId);
  // Only this task is read, in every pool: the routing decides which one holds it.
  const pairs = await listIdleRolePairs(deps.db, row.companyId, { order: queueOrderOf(deps), issueId });
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
    const pool = await availableAgents(deps, row.companyId, freeAgentsOfPair(pair, deps.settings, caste));
    const chosen = await pairTaskWithPool(deps, row.companyId, task, pool, new Set());
    if (!chosen || chosen === "lost") return null;
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
      name: agents.name,
      reportsTo: agents.reportsTo,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!agentRow?.companyId) return null;
  if (agentRow.status === "paused" || agentRow.status === "terminated") return null;
  // An agent the wake layer will refuse is woken for nothing — neither for its
  // own task nor for a queue task (design §3.2; ADM review of 18a69ff91).
  if (!(await evaluateAgentInvokabilityFromDb(deps.db, agentRow)).invokable) return null;
  if (!(await isAvailable(deps, agentRow.companyId, agentId))) return null;

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
  const pairs = await listIdleRolePairs(deps.db, agentRow.companyId, {
    order: queueOrderOf(deps),
    roles: [agentRow.role],
  });
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

  // The pool read is already in the queue order (`swarmQueueOrderBy`).
  for (const candidate of pair.queue) {
    if (candidate.assigneeAgentId) continue;
    if (await isCooling(deps, agentRow.companyId, candidate.issueId)) continue;
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
  const pairs = await listIdleRolePairs(deps.db, companyId, { order: queueOrderOf(deps) });
  for (const pair of pairs) {
    // The pool read is already in the queue order (`swarmQueueOrderBy`).
    const own = pair.queue.filter((entry) => entry.assigneeAgentId === agentId);
    for (const candidate of own) {
      if (options.excludeIssueId && candidate.issueId === options.excludeIssueId) continue;
      if (await isCooling(deps, companyId, candidate.issueId)) continue;
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
//
// 1.6.5 (F-27, #1047): the pool of a caste is read with the queue reads' own
// SQL — the routing of an unassigned task is `unassignedTaskRoutedToRole`, the
// order `swarmQueueOrderBy` over the `failedRunsDerivedSql` join. There is no
// JS twin of either here: the rows come back in the order the matcher walks.
// ---------------------------------------------------------------------------

/** One queue entry: an unassigned task, or one that already has an owner. */
export interface SwarmMatcherQueueCandidate {
  issueId: string;
  identifier?: string | null;
  priority: string | null;
  /** 1.6.5 (F-27): the stored pheromone strength of the task. */
  pheromoneStrength?: number | null;
  /** 1.6.5 (F-27): runs that evaporated pheromone with no task change after them. */
  failedRunsSinceLastChange?: number | null;
  /** When the task entered the queue (the age key of the order). */
  queuedAt: Date | number | string | null;
  assigneeAgentId?: string | null;
}

const LIVE_HEARTBEAT_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;

/** The most rows one caste's pool read hands to a pass. */
const SWARM_POOL_READ_LIMIT = 200;

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
    /** 1.6.5 (OPE-6608 B): the agent's newest run (observability; the pick is T10's). */
    lastActiveAt: Date | null;
    /** The vendor invokability of the agent (`evaluateAgentInvokability`); absent reads as invokable. */
    invokable?: boolean;
  }[];
}

/** What a pool read is narrowed to. */
export interface SwarmPoolReadOptions {
  /** The queue order of the pass (P0 switch, pheromone dynamics, clock). */
  order?: SwarmQueueOrderOptions;
  /** Only these castes (the freed agent's own); default every caste an agent holds. */
  roles?: readonly string[];
  /** Only this task (the event "this task became ready"). */
  issueId?: string;
}

/**
 * Every caste of the company that an agent holds, with its ready queue (only
 * castes with at least one ready row are returned) and every agent of that
 * caste with its live-claim count. The queue of a caste is the tasks assigned to
 * an agent of the caste plus the unassigned tasks routed to it, already in the
 * queue order. The per-agent ceiling is NOT applied here (it can be
 * caste-overridden per agent); the pool policy above decides freeness. A task
 * routed to a caste no agent holds is in no pool: nobody could be woken for it.
 */
export async function listIdleRolePairs(
  db: Db,
  companyId: string,
  options: SwarmPoolReadOptions = {},
): Promise<SwarmIdleRolePair[]> {
  const [agentRows, liveRunAgentIds, lastRunRows, activeClaimCounts] = await Promise.all([
    db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        name: agents.name,
        reportsTo: agents.reportsTo,
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

  const wanted = options.roles ? new Set(options.roles) : null;
  const roles = [
    ...new Set(
      agentRows
        .map((agent) => agent.role)
        .filter((role): role is string => typeof role === "string" && role.trim().length > 0),
    ),
  ]
    .filter((role) => !wanted || wanted.has(role))
    .sort();

  const queues = await Promise.all(
    roles.map((role) =>
      listReadyQueueCandidates(db, companyId, role, {
        order: options.order,
        issueId: options.issueId,
      }),
    ),
  );

  const pairs: SwarmIdleRolePair[] = [];
  roles.forEach((role, index) => {
    const queue = queues[index] ?? [];
    if (queue.length === 0) return;
    const roleAgents = agentRows
      .filter((agent) => agent.role === role)
      .map((agent) => ({
        id: agent.id,
        status: agent.status,
        activeClaims: activeClaimCounts.get(agent.id) ?? 0,
        hasLiveRun: liveRuns.has(agent.id),
        metadata: (agent.metadata as Record<string, unknown> | null) ?? null,
        lastActiveAt: lastActive.get(agent.id) ?? null,
        // The vendor rule over the company's own rows (status and the whole
        // reporting chain), the one the wake layer applies.
        invokable: evaluateAgentInvokability(agent, agentRows).invokable,
      }));
    pairs.push({ role, companyId, queue, agents: roleAgents });
  });
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

/**
 * "Ready and waiting" over the outer `issues` row: the readiness filters of
 * idle-pickup (no open blocker, not a plan container, not mid-decomposition, not
 * held) and nothing that already covers the task (a live lease, a wake in
 * flight that is not parked on a hold). One list, used by the pool read and by
 * the panel counters, so "ready" means one thing in both.
 */
function readyQueueConditions(db: Db, companyId: string): SQL[] {
  return [
    eq(issues.companyId, companyId),
    isNull(issues.assigneeUserId),
    isNull(issues.hiddenAt),
    isNull(issues.conversationAgentId),
    inArray(issues.status, [...SWARM_CLAIM_QUEUE_ISSUE_STATUSES]),
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
  ];
}

/**
 * The ready queue of one caste: the tasks assigned to an agent of the caste,
 * and the unassigned tasks the routing sends to it (`unassignedTaskRoutedToRole`
 * — the same predicate the claim API's role queue uses), in the queue order
 * (`swarmQueueOrderBy` over the `failedRunsDerivedSql` join).
 */
async function listReadyQueueCandidates(
  db: Db,
  companyId: string,
  role: string,
  options: { order?: SwarmQueueOrderOptions; issueId?: string } = {},
): Promise<SwarmMatcherQueueCandidate[]> {
  const conditions = [
    ...readyQueueConditions(db, companyId),
    or(
      and(isNotNull(issues.assigneeAgentId), eq(agents.role, role)),
      and(isNull(issues.assigneeAgentId), unassignedTaskRoutedToRole(role)),
    ),
  ];
  if (options.issueId) conditions.push(eq(issues.id, options.issueId));
  const rows = await db
    .select({
      issueId: issues.id,
      identifier: issues.identifier,
      priority: issues.priority,
      pheromoneStrength: issues.pheromoneStrength,
      failedRunsSinceLastChange: failedRunsSinceLastChangeSql(),
      queuedAt: issues.createdAt,
      assigneeAgentId: issues.assigneeAgentId,
    })
    .from(issues)
    .leftJoin(agents, eq(agents.id, issues.assigneeAgentId))
    // One bounded pass over the recent evaporating runs, joined once (#1047).
    .leftJoin(failedRunsDerivedSql(companyId, options.order?.now), failedRunsJoinOnSql())
    .where(and(...conditions))
    .orderBy(...swarmQueueOrderBy(options.order))
    .limit(SWARM_POOL_READ_LIMIT);
  return rows.map((row) => ({
    issueId: row.issueId,
    identifier: row.identifier,
    priority: row.priority,
    pheromoneStrength: row.pheromoneStrength,
    failedRunsSinceLastChange: row.failedRunsSinceLastChange,
    queuedAt: row.queuedAt,
    assigneeAgentId: row.assigneeAgentId,
  }));
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
      const [queuedRows, claimedRows, cancelledRows] = await Promise.all([
        db
          .select({ queued: count() })
          .from(issues)
          .where(and(...readyQueueConditions(db, companyId), isNull(issues.assigneeAgentId))),
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
        queuedUnassigned: Number(queuedRows[0]?.queued ?? 0),
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