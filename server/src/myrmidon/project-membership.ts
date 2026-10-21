// server/src/myrmidon/project-membership.ts
//
// myrmidon(1.6.6 PROJECT-SCOPED-CLAIM): the canonical agent→project membership
// predicate, shared by every automatic task-taking path (swarm claim, idle
// wake) and by the agent roster the board UI filters by (OPE-7282).
//
// The rule is the one `scope-wiring.listAgents` already answers for bot
// containers, stated once here so the paths cannot drift apart:
//
//   agent ∈ project ⇔ projects.lead_agent_id = agent.id
//                     ∨ exists project_memberships(company_id, project_id,
//                           user_id = agent.id, state = 'joined')
//                     ∨ exists agent_nests(company_id, project_id,
//                           agent_id = agent.id)       -- nest (decision 18.10)
//
// `project_memberships.user_id` is polymorphic. For an agent, membership
// counts only when that ID resolves to an agent in the same company; this
// keeps human-user IDs from masquerading as agent IDs. A task without a
// project stays open to the company. A manually assigned task is never gated.

import { and, eq, isNotNull, sql, type SQL } from "drizzle-orm";
import { agentNests, agents, issues, projectMemberships, projects, type Db } from "@paperclipai/db";

/**
 * The claim gate over the outer `issues` row (a SQL twin of
 * `unassignedTaskRoutedToRole`'s style): TRUE when the row's task may be
 * self-served by `agentId` — a projectless task is open to the company, a
 * project task only to a member of that project (its lead, a joined
 * member, or an agent nested in it).
 */
export function projectScopedClaimGate(agentId: string): SQL {
  const agentRef = sql`${agentId}::uuid`;
  return sql`(
    ${issues.projectId} is null
    or exists (
      select 1
      from projects p
      where p.company_id = ${issues.companyId}
        and p.id = ${issues.projectId}
        and exists (
          select 1 from agents a
          where a.id = ${agentRef}
            and a.company_id = ${issues.companyId}
        )
        and (
          p.lead_agent_id = ${agentRef}
          or exists (
            select 1
            from project_memberships pm
              join agents a
                on a.company_id = pm.company_id
               and a.id::text = pm.user_id
            where pm.company_id = ${issues.companyId}
              and pm.project_id = ${issues.projectId}
              and pm.user_id = ${sql`${agentRef}::text`}
              and pm.state = 'joined'
              and a.id = ${agentRef}
          )
          or exists (
            select 1
            from agent_nests n
            where n.company_id = ${issues.companyId}
              and n.project_id = ${issues.projectId}
              and n.agent_id = ${agentRef}
          )
        )
    )
  )`;
}

/**
 * Per-project member agent ids of a company (leads + joined members) — the
 * read the idle pass uses to keep a project's unassigned tasks for its
 * members.
 */
export async function projectMembershipByProject(
  db: Db,
  companyId: string,
): Promise<Map<string, Set<string>>> {
  const [ledRows, joinedRows, nestRows] = await Promise.all([
    db
      .select({ projectId: projects.id, leadAgentId: projects.leadAgentId })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), isNotNull(projects.leadAgentId))),
    db
      .select({
        projectId: projectMemberships.projectId,
        userId: projectMemberships.userId,
      })
      .from(projectMemberships)
      .innerJoin(
        agents,
        and(
          eq(projectMemberships.userId, sql`${agents.id}::text`),
          eq(projectMemberships.companyId, agents.companyId),
        ),
      )
      .where(
        and(
          eq(projectMemberships.companyId, companyId),
          eq(projectMemberships.state, "joined"),
        ),
      ),
    db
      .select({ projectId: agentNests.projectId, agentId: agentNests.agentId })
      .from(agentNests)
      .where(eq(agentNests.companyId, companyId)),
  ]);
  const byProject = new Map<string, Set<string>>();
  const add = (projectId: string, agentId: string | null) => {
    if (!agentId) return;
    const set = byProject.get(projectId) ?? new Set<string>();
    set.add(agentId);
    byProject.set(projectId, set);
  };
  for (const row of ledRows) add(row.projectId, row.leadAgentId);
  for (const row of joinedRows) add(row.projectId, row.userId);
  for (const row of nestRows) add(row.projectId, row.agentId);
  return byProject;
}

/**
 * Member agent ids (lead + joined) of ONE project — the read the matcher uses
 * to keep a project's unassigned task inside its membership.
 */
export async function projectMemberAgentIds(
  db: Db,
  companyId: string,
  projectId: string,
): Promise<Set<string>> {
  const [ledRows, joinedRows, nestRows] = await Promise.all([
    db
      .select({ leadAgentId: projects.leadAgentId })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), eq(projects.id, projectId))),
    db
      .select({ userId: projectMemberships.userId })
      .from(projectMemberships)
      .innerJoin(
        agents,
        and(
          eq(projectMemberships.userId, sql`${agents.id}::text`),
          eq(projectMemberships.companyId, agents.companyId),
        ),
      )
      .where(
        and(
          eq(projectMemberships.companyId, companyId),
          eq(projectMemberships.projectId, projectId),
          eq(projectMemberships.state, "joined"),
        ),
      ),
    db
      .select({ agentId: agentNests.agentId })
      .from(agentNests)
      .where(and(eq(agentNests.companyId, companyId), eq(agentNests.projectId, projectId))),
  ]);
  const members = new Set<string>();
  for (const row of ledRows) if (row.leadAgentId) members.add(row.leadAgentId);
  for (const row of joinedRows) members.add(row.userId);
  for (const row of nestRows) members.add(row.agentId);
  return members;
}

/**
 * The agent→projects map of a company — the roster half of the same rule.
 * `GET /companies/:id/agents` ships it as `AgentListItem.projectIds`, the
 * contract the board UI's agent filters consume (OPE-7282: client-side
 * filtering over the already-loaded roster, no new server filter endpoint).
 */
export async function listAgentProjectIds(
  db: Db,
  companyId: string,
): Promise<Map<string, string[]>> {
  const byProject = await projectMembershipByProject(db, companyId);
  const byAgent = new Map<string, string[]>();
  for (const [projectId, agentIds] of byProject) {
    for (const agentId of agentIds) {
      const list = byAgent.get(agentId) ?? [];
      list.push(projectId);
      byAgent.set(agentId, list);
    }
  }
  return byAgent;
}
