// server/src/myrmidon/project-membership.ts
//
// myrmidon(1.6.6 PROJECT-SCOPED-CLAIM): the canonical agent→project membership
// predicate, in SQL, shared by every automatic task-taking path.
//
// The rule is the one `scope-wiring.listAgents` already answers for bot
// containers ("An agent's projects: the ones it leads and the ones that list it
// as a joined member"), stated once so claim, idle pickup and caste assignment
// cannot drift apart:
//
//   agent ∈ project ⇔ projects.lead_agent_id = agent.id
//                     ∨ exists project_memberships(company_id, project_id, user_id = agent.id, state = 'joined')
//
// `project_memberships.user_id` is the polymorphic principal id (a human user
// id or, for agents, the agent's own id) — the same comparison
// `scope-wiring.listAgents` performs (`inArray(projectMemberships.userId, ids)`
// over agent ids). A task with a `project_id` is claimable only by a member of
// that project; a task without one is open to every agent of the company, as
// before.
import { sql, type SQL } from "drizzle-orm";
import { issues } from "@paperclipai/db";

/**
 * The membership half alone: TRUE when the agent is a member of the project the
 * row's `project_id` points at. For a NULL `project_id` it is FALSE — callers
// combine it with `project_id IS NULL` to keep projectless tasks open.
 */
export function agentIsProjectMemberSql(agentId: string, projectIdColumn: SQL | ReturnType<(typeof issues)["projectId"]["getSQL"]>): SQL {
  return sql`(
    ${projectIdColumn} is null
    or exists (
      select 1
      from projects mp
      where mp.company_id = ${issues.companyId}
        and mp.id = ${projectIdColumn}
        and (
          mp.lead_agent_id = ${agentId}
          or exists (
            select 1
            from project_memberships pm
            where pm.company_id = ${issues.companyId}
              and pm.project_id = ${projectIdColumn}
              and pm.user_id = ${agentId}
              and pm.state = 'joined'
          )
        )
    )
  )`;
}
