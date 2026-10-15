// server/src/myrmidon/swarm-claim/queue.ts
//
// myrmidon(1.6-SWARM): the per-role queue read.
//
// A role's queue is the open `todo` tasks whose assignee is the role — either
// explicitly assigned to an agent of that role, or unassigned and therefore
// waiting for the role to self-serve it. The design note leaves the exact
// membership to the engineer; the choice here is deliberately the wider one
// ("todo and no live claim"), because the point of 1.6 is that an agent finds
// work without the lead hand-assigning it: a queue that only contained
// already-assigned tasks would keep the lead in the loop it is meant to remove.
//
// What is excluded is what the vendor's own readiness rules exclude — hidden
// tasks, conversations, tasks with an unresolved blocker, plan containers with
// open children, tasks mid-decomposition — copied from `idle-pickup.ts` rather
// than re-derived, so "ready" means one thing on both paths.

import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { agents, issues, type Db } from "@paperclipai/db";
import {
  SWARM_CLAIM_QUEUE_ISSUE_STATUSES,
  SWARM_DEFAULT_UNASSIGNED_ROLE,
  type SwarmQueueCandidate,
} from "@paperclipai/shared";
import { issueHasNoExecutionHold } from "../settled-holds/ready-predicate.js";
import {
  failedRunsDerivedSql,
  failedRunsJoinOnSql,
  failedRunsSinceLastChangeSql,
  swarmQueueOrderBy,
  type SwarmQueueOrderOptions,
} from "./effective-pheromone.js";

/** One row of a role queue as the SQL reads it, before the claim join. */
export interface RoleQueueRow {
  issueId: string;
  identifier: string | null;
  priority: string | null;
  /** 1.6.5 (F-27): the pheromone strength the queue orders by. */
  pheromoneStrength: number | null;
  /**
   * 1.6.5 (F-27 rework 09.10): runs that evaporated pheromone with no task
   * change after them — the effective strength subtracts `failPenalty` per
   * run (design §2.3, SQL twin in `effective-pheromone.ts`).
   */
  failedRunsSinceLastChange: number | null;
  status: string;
  assigneeAgentId: string | null;
  role: string | null;
  queuedAt: Date | null;
}

/**
 * myrmidon(1.6.2 SWARM-UNASSIGNED-ROUTE): the routing of an unassigned task
 * over the outer `issues` row — true when it is queued for `role`. The one
 * routing rule: the role queues here and the board matcher's pool read
 * (`listIdleRolePairs`, matcher.ts) both filter by it.
 *
 * 1.6.5 (F-27 rework 09.10, design §2.1) + review #1047 п.4: the task's caste
 * is the first non-blank of `issues.caste_key`, then the project's
 * `projects.default_caste_key`. When the task has a caste, THAT caste alone
 * decides — the legacy `role:<key>` label is consulted only for a task that
 * names no caste anywhere (rows written before the migration), exactly as the
 * JS twin does. Without a caste and without a role label the task belongs to
 * the company default role.
 */
export function unassignedTaskRoutedToRole(role: string) {
  const wantedKey = role.trim().toLowerCase();
  const wanted = `role:${wantedKey}`;
  const hasLabel = sql`exists (
    select 1
    from issue_labels il
      join labels l on l.id = il.label_id
    where il.issue_id = ${issues.id}
      and regexp_replace(lower(btrim(l.name)), '^role:[[:space:]]*', 'role:') = ${wanted}
  )`;
  const hasAnyRoleLabel = sql`exists (
    select 1
    from issue_labels il
      join labels l on l.id = il.label_id
    where il.issue_id = ${issues.id}
      and lower(btrim(l.name)) ~ '^role:[[:space:]]*[^[:space:]]'
  )`;
  const effectiveCaste = sql`coalesce(
    nullif(lower(btrim(${issues.casteKey})), ''),
    (select nullif(lower(btrim(p.default_caste_key)), '') from projects p where p.id = ${issues.projectId})
  )`;
  const labelRoute =
    wantedKey === SWARM_DEFAULT_UNASSIGNED_ROLE
      ? sql`(${hasLabel} or not ${hasAnyRoleLabel})`
      : hasLabel;
  return sql`(case when ${effectiveCaste} is not null then ${effectiveCaste} = ${wantedKey} else ${labelRoute} end)`;
}

/**
 * The candidate rows of one role's queue. With `agentId` the assigned part is
 * that agent's own todo only (a task assigned to a peer is the peer's, not
 * this agent's); the unassigned part is the tasks routed to the role. The status filter is the queue
 * statuses (`todo`); the readiness filters mirror `idlePickupCandidateRows`.
 */
export function roleQueueRows(
  db: Db,
  companyId: string,
  role: string,
  agentId?: string,
  order?: SwarmQueueOrderOptions,
) {
  return db
    .select({
      issueId: issues.id,
      identifier: issues.identifier,
      priority: issues.priority,
      pheromoneStrength: issues.pheromoneStrength,
      failedRunsSinceLastChange: failedRunsSinceLastChangeSql(),
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      role: agents.role,
      queuedAt: issues.createdAt,
    })
    .from(issues)
    .leftJoin(agents, eq(agents.id, issues.assigneeAgentId))
    // One bounded pass over the recent evaporating runs, joined once — not a
    // correlated subquery per candidate (review #1047).
    .leftJoin(failedRunsDerivedSql(companyId, order?.now), failedRunsJoinOnSql())
    .where(
      and(
        eq(issues.companyId, companyId),
        isNull(issues.assigneeUserId),
        isNull(issues.hiddenAt),
        isNull(issues.conversationAgentId),
        inArray(issues.status, [...SWARM_CLAIM_QUEUE_ISSUE_STATUSES]),
        // The task belongs to this agent/role: assigned to the agent (or, with
        // no agent given, to an agent of the role), or unassigned and routed
        // to the role by its label (default: the engineer).
        or(
          agentId ? eq(issues.assigneeAgentId, agentId) : eq(agents.role, role),
          and(isNull(issues.assigneeAgentId), unassignedTaskRoutedToRole(role)),
        ),
        // Not blocked by an unresolved blocker (the same rule idle-pickup uses).
        sql`not exists (
          select 1
          from issue_relations ir
            join issues blocker on blocker.id = ir.issue_id and blocker.company_id = ${issues.companyId}
          where ir.company_id = ${issues.companyId}
            and ir.related_issue_id = ${issues.id}
            and ir.type = 'blocks'
            and blocker.status <> 'done'
        )`,
        // Not a container: an issue with an open child is a plan, the children are the work.
        sql`not exists (
          select 1
          from issues child
          where child.company_id = ${issues.companyId}
            and child.parent_id = ${issues.id}
            and child.status not in ('done', 'cancelled')
        )`,
        // Not mid-decomposition (see idle-pickup.ts for why this races otherwise).
        sql`not exists (
          select 1
          from issue_plan_decompositions decomp
          where decomp.company_id = ${issues.companyId}
            and decomp.source_issue_id = ${issues.id}
            and decomp.status = 'in_flight'
        )`,
        // myrmidon(HOLD-READY): not held by an execution hold (see idle-pickup.ts).
        issueHasNoExecutionHold(db),
      ),
    )
    .orderBy(...swarmQueueOrderBy(order))
    .limit(200);
}

/** The queue rows of a role, as candidates the pure ordering takes. */
export async function listRoleQueue(
  db: Db,
  companyId: string,
  role: string,
  agentId?: string,
  order?: SwarmQueueOrderOptions,
): Promise<SwarmQueueCandidate[]> {
  const rows = await roleQueueRows(db, companyId, role, agentId, order);
  return rows.map((row) => ({
    issueId: row.issueId,
    identifier: row.identifier,
    priority: row.priority,
    pheromoneStrength: row.pheromoneStrength,
    failedRunsSinceLastChange: row.failedRunsSinceLastChange,
    queuedAt: row.queuedAt,
  }));
}

/** The agent ids of one role in a company — the agents a queue wake may target. */
export async function listAgentsOfRole(
  db: Db,
  companyId: string,
  role: string,
): Promise<Array<{ id: string; companyId: string; name: string; role: string; status: string }>> {
  return db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      role: agents.role,
      status: agents.status,
    })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.role, role)));
}

/** The distinct roles that currently have anything queued in a company. */
export async function listQueuedRoles(db: Db, companyId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ role: agents.role })
    .from(issues)
    .leftJoin(agents, eq(agents.id, issues.assigneeAgentId))
    .where(
      and(
        eq(issues.companyId, companyId),
        isNull(issues.assigneeUserId),
        isNull(issues.hiddenAt),
        isNull(issues.conversationAgentId),
        inArray(issues.status, [...SWARM_CLAIM_QUEUE_ISSUE_STATUSES]),
      ),
    );
  // Unassigned tasks belong to every role they could be taken by; the caller
  // unions them with the assigned ones. Returning them as their own marker keeps
  // this read cheap; `listUnassignedQueue` is the other half.
  return rows.map((row) => row.role).filter((role): role is string => Boolean(role));
}

/**
 * The unassigned `todo` tasks of a company: work that any role may take, and
 * therefore the part of every role's queue that has no role of its own.
 */
export async function listUnassignedQueue(
  db: Db,
  companyId: string,
  order?: SwarmQueueOrderOptions,
): Promise<SwarmQueueCandidate[]> {
  const rows = await db
    .select({
      issueId: issues.id,
      identifier: issues.identifier,
      priority: issues.priority,
      pheromoneStrength: issues.pheromoneStrength,
      failedRunsSinceLastChange: failedRunsSinceLastChangeSql(),
      queuedAt: issues.createdAt,
    })
    .from(issues)
    // One bounded pass over the recent evaporating runs, joined once — not a
    // correlated subquery per candidate (review #1047).
    .leftJoin(failedRunsDerivedSql(companyId, order?.now), failedRunsJoinOnSql())
    .where(
      and(
        eq(issues.companyId, companyId),
        isNull(issues.assigneeAgentId),
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
        // myrmidon(HOLD-READY): not held by an execution hold (see idle-pickup.ts).
        issueHasNoExecutionHold(db),
      ),
    )
    .orderBy(...swarmQueueOrderBy(order))
    .limit(200);
  return rows.map((row) => ({
    issueId: row.issueId,
    identifier: row.identifier,
    priority: row.priority,
    pheromoneStrength: row.pheromoneStrength,
    failedRunsSinceLastChange: row.failedRunsSinceLastChange,
    queuedAt: row.queuedAt,
  }));
}