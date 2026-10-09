// server/src/myrmidon/swarm-claim/store.ts
//
// myrmidon(1.6-SWARM): every read and write of the `issue_claims` table.
//
// One module owns the table, so the queue, the sweep, the run lifecycle hooks
// and the supervisor rebalance all go through the same functions and the same
// rules about what makes a claim live. The supervisor part (OPE-3609) calls
// `releaseClaim` from here rather than writing the table itself — that is the
// interface the two parts agreed on.

import { and, asc, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { isUniqueViolation } from "../../db-errors.js";
import { issueClaims, issues, type Db } from "@paperclipai/db";
import {
  SWARM_CLAIM_QUEUE_ISSUE_STATUSES,
  type SwarmClaimLease,
} from "@paperclipai/shared";

/** A lease row reshaped into the shared contract both parts order and render. */
function toLease(row: typeof issueClaims.$inferSelect): SwarmClaimLease {
  return {
    id: row.id,
    issueId: row.issueId,
    agentId: row.agentId,
    heartbeatAt: row.heartbeatAt,
    expiresAt: row.expiresAt,
    releasedAt: row.releasedAt,
  };
}

/** Every claim row of one company, newest first — the raw read the supervisor view builds on. */
export async function listCompanyClaims(
  db: Db,
  companyId: string,
  limit = 500,
): Promise<Array<typeof issueClaims.$inferSelect>> {
  return db
    .select()
    .from(issueClaims)
    .where(eq(issueClaims.companyId, companyId))
    .orderBy(asc(issueClaims.claimedAt))
    .limit(limit);
}

/** The live (not released) claim of a task, or null. */
export async function findLiveClaimForIssue(
  db: Db,
  issueId: string,
): Promise<SwarmClaimLease | null> {
  const rows = await db
    .select()
    .from(issueClaims)
    .where(and(eq(issueClaims.issueId, issueId), isNull(issueClaims.releasedAt)))
    .orderBy(asc(issueClaims.claimedAt));
  if (rows.length === 0) return null;
  return toLease(rows[rows.length - 1]!);
}

/**
 * 1.6.1 (SWARM-SETTINGS-UI): every live claim of the instance, oldest first —
 * the read the disable path of the sweep uses to free the leases a pilot
 * switch-off left behind. Bounded by the caller's page size.
 */
export async function listAllLiveClaims(
  db: Db,
  limit = 200,
): Promise<Array<typeof issueClaims.$inferSelect>> {
  return db
    .select()
    .from(issueClaims)
    .where(isNull(issueClaims.releasedAt))
    .orderBy(asc(issueClaims.claimedAt))
    .limit(limit);
}

/** The live claims of one agent within a company — what the per-agent ceiling counts. */
export async function listAgentLiveClaims(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<SwarmClaimLease[]> {
  const rows = await db
    .select()
    .from(issueClaims)
    .where(
      and(
        eq(issueClaims.companyId, companyId),
        eq(issueClaims.agentId, agentId),
        isNull(issueClaims.releasedAt),
      ),
    )
    .orderBy(asc(issueClaims.claimedAt));
  return rows.map(toLease);
}

/** Live claims of many issues at once, keyed by issue id. */
export async function liveClaimsForIssues(
  db: Db,
  issueIds: readonly string[],
): Promise<Map<string, SwarmClaimLease>> {
  const map = new Map<string, SwarmClaimLease>();
  if (issueIds.length === 0) return map;
  const rows = await db
    .select()
    .from(issueClaims)
    .where(and(inArray(issueClaims.issueId, [...issueIds]), isNull(issueClaims.releasedAt)))
    .orderBy(asc(issueClaims.claimedAt));
  for (const row of rows) map.set(row.issueId, toLease(row));
  return map;
}

/**
 * Live claims of one company that have run out at `now`: never released and
 * `expires_at` at or before the cutoff. This is the sweep's one read, and it is
 * indexed by `issue_claims_expires_idx`.
 *
 * design §4.1, correction 1 (review item 7): a lease the board wrote and no run
 * has checked out yet (`run_id IS NULL`) does not expire while a wake for its
 * task is in flight (`queued` / `deferred_issue_execution` / `claimed`, not
 * parked on an execution hold). The start limit holds a wake in the queue; the
 * lease must outlast that wait, or the sweep takes the owner off a task whose
 * run is about to start and the run is cancelled as `reassigned`.
 */
export async function listExpiredClaims(
  db: Db,
  companyId: string | null,
  now: Date,
  limit = 200,
): Promise<Array<typeof issueClaims.$inferSelect>> {
  const conditions = [
    isNull(issueClaims.releasedAt),
    lt(issueClaims.expiresAt, now),
    sql`(${issueClaims.runId} is not null or not exists (
      select 1 from agent_wakeup_requests w
      where w.company_id = ${issueClaims.companyId}
        and w.status in ('queued', 'deferred_issue_execution', 'claimed')
        and w.payload ->> 'issueId' = ${issueClaims.issueId}::text
        and not (
          w.status = 'deferred_issue_execution'
          and coalesce(jsonb_typeof(w.payload -> 'executionWait'), 'null') = 'object'
        )
    ))`,
  ];
  if (companyId) conditions.push(eq(issueClaims.companyId, companyId));
  return db
    .select()
    .from(issueClaims)
    .where(and(...conditions))
    .orderBy(asc(issueClaims.expiresAt))
    .limit(limit);
}

/** Live claims whose task left the queue (closed, cancelled, moved on). */
export async function listClaimsOnNonQueueIssues(
  db: Db,
  companyId: string | null,
  queueStatuses: readonly string[],
  limit = 200,
): Promise<Array<typeof issueClaims.$inferSelect>> {
  const conditions = [
    isNull(issueClaims.releasedAt),
    notInArray(issues.status, [...queueStatuses]),
  ];
  if (companyId) conditions.push(eq(issueClaims.companyId, companyId));
  return db
    .select({ claim: issueClaims })
    .from(issueClaims)
    .innerJoin(issues, eq(issues.id, issueClaims.issueId))
    .where(and(...conditions))
    .orderBy(asc(issueClaims.claimedAt))
    .limit(limit)
    .then((rows) => rows.map((row) => row.claim));
}

/**
 * Take a lease on a task. Refuses (returns null) when any other live claim
 * already covers the task, so two agents racing on the same queue row cannot
 * both win: the second write sees the first claim and loses. The caller then
 * treats the task as taken and moves to the next candidate.
 */
export async function insertClaim(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    agentId: string;
    role: string | null;
    runId: string | null;
    claimedAt: Date;
    heartbeatAt: Date;
    expiresAt: Date;
  },
): Promise<SwarmClaimLease | null> {
  const existing = await db
    .select({ id: issueClaims.id })
    .from(issueClaims)
    .where(and(eq(issueClaims.issueId, input.issueId), isNull(issueClaims.releasedAt)))
    .limit(1);
  if (existing.length > 0) return null;

  const inserted = await db
    .insert(issueClaims)
    .values({
      companyId: input.companyId,
      issueId: input.issueId,
      agentId: input.agentId,
      role: input.role,
      runId: input.runId,
      claimedAt: input.claimedAt,
      heartbeatAt: input.heartbeatAt,
      expiresAt: input.expiresAt,
    })
    .returning()
    // 1.6.5 (OPE-5401 ч.A): the pre-check above is advisory — two processes can pass it
    // in the same window. The partial unique index `issue_claims_issue_active_uq`
    // (issue_id WHERE released_at IS NULL) is the real gate, and 23505 is the losing side
    // of the race, not a failure: same null = «занято» as the pre-check returns.
    .catch((err: unknown) => {
      if (isUniqueViolation(err)) return [];
      throw err;
    });
  const row = inserted[0];
  return row ? toLease(row) : null;
}

/**
 * 1.6.5 (OPE-6608 SWARM-WAKE-FIX A): the queue's own assignment. Before this,
 * the idle pass woke an agent and trusted the run to claim the task on
 * checkout — and the dispatcher cancelled every such run first, because an
 * unassigned issue does not belong to the agent the wake named
 * (`decideIssueOwnership` saw NULL ≠ runAgentId and read it as "reassigned").
 * The queue now does what a claim does, on the server, before the wake: the
 * issue is assigned to the agent under a conditional update (assignee still
 * empty, status still a queue status) and the claim row is written behind the
 * same partial unique index the checkout path uses. Returns false when the
 * task was taken meanwhile — then nobody is woken for it.
 */
export async function assignIssueToAgentForIdleClaim(
  db: Db,
  input: { companyId: string; issueId: string; agentId: string; now: Date },
): Promise<boolean> {
  const updated = await db
    .update(issues)
    .set({ assigneeAgentId: input.agentId, updatedAt: input.now })
    .where(
      and(
        eq(issues.id, input.issueId),
        eq(issues.companyId, input.companyId),
        isNull(issues.assigneeAgentId),
        inArray(issues.status, [...SWARM_CLAIM_QUEUE_ISSUE_STATUSES]),
      ),
    )
    .returning({ id: issues.id });
  return updated.length > 0;
}

/**
 * Undo of `assignIssueToAgentForIdleClaim`: used when the assignment landed but
 * the claim row lost the race (someone claimed the task in between). The
 * assignment is reverted so the task stays in the queue for the next pass
 * instead of dangling on an agent that holds no lease.
 */
export async function revertIdleClaimAssignment(
  db: Db,
  input: { companyId: string; issueId: string; agentId: string; now: Date },
): Promise<boolean> {
  const reverted = await db
    .update(issues)
    .set({ assigneeAgentId: null, updatedAt: input.now })
    .where(
      and(
        eq(issues.id, input.issueId),
        eq(issues.companyId, input.companyId),
        eq(issues.assigneeAgentId, input.agentId),
      ),
    )
    .returning({ id: issues.id });
  return reverted.length > 0;
}

/**
 * 1.6.5 (OPE-6608 §4.1, review item 2): take the owner off a task whose lease
 * lapsed with no run behind it. The old pass left the assignee in place and
 * woke a DIFFERENT agent on the task; that run was then cancelled as
 * `reassigned` before its checkout — the failure this ticket exists for.
 * Conditional on purpose: a task that moved on (status left the queue, or the
 * owner changed meanwhile) is left exactly as it is, and the conditional update
 * is the same shape the claim path uses.
 */
export async function clearExpiredAssignee(
  db: Db,
  input: { companyId: string; issueId: string; agentId: string; now: Date },
): Promise<boolean> {
  const cleared = await db
    .update(issues)
    .set({ assigneeAgentId: null, updatedAt: input.now })
    .where(
      and(
        eq(issues.id, input.issueId),
        eq(issues.companyId, input.companyId),
        eq(issues.assigneeAgentId, input.agentId),
        inArray(issues.status, [...SWARM_CLAIM_QUEUE_ISSUE_STATUSES]),
      ),
    )
    .returning({ id: issues.id });
  return cleared.length > 0;
}

/**
 * Release a live claim: stamp `released_at` and the reason. Returns true when
 * this call was the one that released it, false when the claim was already
 * released or does not exist (so a double release is a no-op, not an error).
 * The supervisor rebalance calls this with reason `supervisor_rebalance`.
 */
export async function releaseClaim(
  db: Db,
  input: { claimId: string; reason: string; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const updated = await db
    .update(issueClaims)
    .set({ releasedAt: now, releaseReason: input.reason })
    .where(and(eq(issueClaims.id, input.claimId), isNull(issueClaims.releasedAt)))
    .returning({ id: issueClaims.id });
  return updated.length > 0;
}

/** Release the live claim of one task (if any). Returns the released claim id, or null. */
export async function releaseClaimsForIssue(
  db: Db,
  input: { issueId: string; reason: string; now?: Date },
): Promise<string[]> {
  const now = input.now ?? new Date();
  const updated = await db
    .update(issueClaims)
    .set({ releasedAt: now, releaseReason: input.reason })
    .where(and(eq(issueClaims.issueId, input.issueId), isNull(issueClaims.releasedAt)))
    .returning({ id: issueClaims.id });
  return updated.map((row) => row.id);
}

/** Release every live claim of one agent (used when an agent stops holding work). */
export async function releaseClaimsForAgent(
  db: Db,
  input: { companyId: string; agentId: string; reason: string; now?: Date },
): Promise<string[]> {
  const now = input.now ?? new Date();
  const updated = await db
    .update(issueClaims)
    .set({ releasedAt: now, releaseReason: input.reason })
    .where(
      and(
        eq(issueClaims.companyId, input.companyId),
        eq(issueClaims.agentId, input.agentId),
        isNull(issueClaims.releasedAt),
      ),
    )
    .returning({ id: issueClaims.id });
  return updated.map((row) => row.id);
}

/** Refresh a lease at a heartbeat: move `heartbeat_at` and `expires_at` forward. */
export async function heartbeatClaim(
  db: Db,
  input: { claimId: string; heartbeatAt: Date; expiresAt: Date },
): Promise<boolean> {
  const updated = await db
    .update(issueClaims)
    .set({ heartbeatAt: input.heartbeatAt, expiresAt: input.expiresAt })
    .where(and(eq(issueClaims.id, input.claimId), isNull(issueClaims.releasedAt)))
    .returning({ id: issueClaims.id });
  return updated.length > 0;
}

/**
 * The prepared statement guard used by the tests: true when the claim table is
 * reachable. Kept here so every caller that needs the table to exist has one
 * place to check instead of each rolling its own probe.
 */
export async function swarmClaimTableReady(db: Db): Promise<boolean> {
  try {
    await db.select({ id: issueClaims.id }).from(issueClaims).limit(1);
    return true;
  } catch {
    return false;
  }
}

/** `or`/`isNull` are re-exported for the supervisor part, which builds its own read. */
export { or, isNull };