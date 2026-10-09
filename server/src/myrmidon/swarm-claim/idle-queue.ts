// server/src/myrmidon/swarm-claim/idle-queue.ts
//
// myrmidon(1.6.1 SWARM-IDLE-WAKE): the DB half of the idle pass.
//
// One read per company answers both halves of the wake pair the ticket names:
// which roles have a non-empty ready queue, and which of their agents are free
// (no live claim, under the ceiling, not paused, no live run). The reads mirror
// `roleQueueRows`/`listRoleQueue` of part A so "ready" means the same thing on
// both paths, with the extra columns the idle pass needs (agents.id,
// agents.status, the live-run set of heartbeat_runs).

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { agents, companies, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import {
  SWARM_CLAIM_QUEUE_ISSUE_STATUSES,
  swarmRoleForUnassignedTask,
} from "@paperclipai/shared";
import type { SwarmIdleQueueCandidate } from "./idle-wake.js";
import { failedRunsSinceLastChangeSql } from "./effective-pheromone.js";
import { issueHasNoExecutionHold } from "../settled-holds/ready-predicate.js";

/** The read-ready role pairs of one company: queue + its agents' idle state. */
export interface SwarmIdleRolePair {
  role: string;
  companyId: string;
  queue: SwarmIdleQueueCandidate[];
  agents: {
    id: string;
    status: string | null;
    activeClaims: number;
    hasLiveRun: boolean;
  }[];
}

const LIVE_HEARTBEAT_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;

/**
 * Every role of a company that has at least one ready queue candidate and
 * every agent of that role, with its live-claim count. The per-agent ceiling
 * is NOT applied here (it can be caste-overridden per agent); the policy in
 * idle-wake.ts decides freeness.
 */
export async function listIdleRolePairs(
  db: Db,
  companyId: string,
): Promise<SwarmIdleRolePair[]> {
  const [queueRows, agentRows, liveRunAgentIds] = await Promise.all([
    listReadyQueueCandidates(db, companyId),
    db
      .select({
        id: agents.id,
        role: agents.role,
        status: agents.status,
      })
      .from(agents)
      .innerJoin(companies, eq(companies.id, agents.companyId))
      .where(and(eq(agents.companyId, companyId), eq(companies.status, "active"))),
    db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, [...LIVE_HEARTBEAT_RUN_STATUSES]),
        ),
      ),
  ] as const);

  const liveRuns = new Set(
    liveRunAgentIds.map((row: { agentId: string }) => row.agentId),
  );
  const byRole = new Map<string, SwarmIdleQueueCandidate[]>();
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
        activeClaims: 0,
        hasLiveRun: liveRuns.has(agent.id),
      }));
    // A role with no agents at all still reports the pair (the supervisor
    // metric counts it), but the policy wakes no one.
    pairs.push({ role, companyId, queue, agents: roleAgents });
  }
  return pairs;
}

/** The live (not released) claim counts per agent of one company. */
export async function liveClaimCountsByAgent(
  db: Db,
  companyId: string,
): Promise<Map<string, number>> {
  const { issueClaims } = await import("@paperclipai/db");
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

/** One raw ready queue row with the roles it belongs to. */
interface ReadyQueueRow {
  candidate: SwarmIdleQueueCandidate;
  assigneeAgentId: string | null;
  assigneeRole: string | null;
  /** Lower-cased names of the issue's labels (the legacy `role:<key>` tag lives here). */
  labels: string[];
  /** 1.6.5 (F-27 rework 09.10): the task's own caste key, and its nest's. */
  casteKey?: string | null;
  projectDefaultCasteKey?: string | null;
}

/** The ready queue of a company (both assigned-to-role and unassigned rows). */
async function listReadyQueueCandidates(db: Db, companyId: string) {
  const rows = await db
    .select({
      issueId: issues.id,
      identifier: issues.identifier,
      priority: issues.priority,
      pheromoneStrength: issues.pheromoneStrength,
      failedRunsSinceLastChange: failedRunsSinceLastChangeSql(),
      queuedAt: issues.createdAt,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeRole: agents.role,
      labels: sql<string[]>`coalesce((
        select array_agg(lower(btrim(l.name)))
        from issue_labels il
          join labels l on l.id = il.label_id
        where il.issue_id = ${issues.id}
      ), array[]::text[])`,
      // 1.6.5 (F-27 rework 09.10, design §2.1): the caste columns — the task's
      // own key, and the nest's default (null when no project).
      casteKey: issues.casteKey,
      projectDefaultCasteKey: sql<string | null>`(
        select p.default_caste_key from projects p where p.id = ${issues.projectId}
      )`,
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
        // myrmidon(1.6.2 SWARM-UNASSIGNED-ROUTE): a task that is already
        // covered — a live claim, or a wake in flight (not parked on a hold) —
        // is being worked on and must not take a queue slot from a task that
        // is not. Filtering here, before the order, is what keeps covered
        // tasks from crowding the free tasks out of the pass.
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
      pheromoneStrength: row.pheromoneStrength,
      failedRunsSinceLastChange: row.failedRunsSinceLastChange,
      queuedAt: row.queuedAt,
      assigneeAgentId: row.assigneeAgentId,
    },
    assigneeAgentId: row.assigneeAgentId,
    assigneeRole: row.assigneeRole ?? null,
    labels: row.labels ?? [],
    casteKey: row.casteKey ?? null,
    projectDefaultCasteKey: row.projectDefaultCasteKey ?? null,
  }));
}

/**
 * Which role queue a ready row belongs to. An assigned task queues for its
 * assignee's role (and, in the pass, for that agent alone); an unassigned task
 * queues for the one role its `role:<key>` label names, the default work role
 * when it has none. A role with no agents still gets its pair, so the sweep
 * can report "ready work, nobody of the role exists" instead of idling silently.
 */
function rolesOfQueueRow(row: ReadyQueueRow): string[] {
  if (row.assigneeAgentId) {
    return row.assigneeRole ? [row.assigneeRole] : [];
  }
  // 1.6.5 (F-27 rework 09.10, design §2.1): the caste the task routes to —
  // its own key, then the nest's default, then the legacy role: label.
  const caste = row.casteKey ?? row.projectDefaultCasteKey ?? null;
  if (caste) return [caste.trim().toLowerCase()];
  return [swarmRoleForUnassignedTask(row.labels)];
}

export { rolesOfQueueRow };
