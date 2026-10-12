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
//
// `project_memberships.user_id` is the polymorphic principal id — for an
// agent it is the agent's own id, which is exactly the comparison
// `scope-wiring.listAgents` performs (`inArray(projectMemberships.userId, ids)`
// over agent ids). A task that carries a `project_id` is self-servable only
// by a member of that project; a task without one stays open to the company.
// A task assigned to an agent is a manual action and is never gated here.

import { and, eq, isNotNull, sql, type SQL } from "drizzle-orm";
import { issues, projectMemberships, projects, type Db } from "@paperclipai/db";

/**
 * The claim gate over the outer `issues` row (a SQL twin of
 * `unassignedTaskRoutedToRole`'s style): TRUE when the row's task may be
 * self-served by `agentId` — a projectless task is open to the company, a
 * project task only to a member of that project (its lead or a joined
 * member).
 */
export function projectScopedClaimGate(agentId: string): SQL {
  return sql`(
    ${issues.projectId} is null
    or exists (
      select 1
      from projects p
      where p.company_id = ${issues.companyId}
        and p.id = ${issues.projectId}
        and (
          p.lead_agent_id = ${agentId}
          or exists (
            select 1
            from project_memberships pm
            where pm.company_id = ${issues.companyId}
              and pm.project_id = ${issues.projectId}
              and pm.user_id = ${agentId}
              and pm.state = 'joined'
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
  const [ledRows, joinedRows] = await Promise.all([
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
      .where(
        and(
          eq(projectMemberships.companyId, companyId),
          eq(projectMemberships.state, "joined"),
        ),
      ),
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
  return byProject;
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
