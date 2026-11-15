import { sql, type SQL } from "drizzle-orm";
import { issues } from "@myrmidon/db";
import { currentRunPrioritySettings } from "./run-priority/state.js";

/** Shared by swarm queue reads and assigned-task idle pickup; reviews bypass it. */
export function releaseFocusCondition(companyId: string): SQL {
  const release = currentRunPrioritySettings().currentRelease;
  if (!release?.trim()) return sql`true`;
  const normalized = release.trim().toLowerCase();
  const matches = (name: SQL) => sql`(
    lower(trim(${name})) = ${normalized}
    or (length(${normalized}) >= 3 and length(lower(trim(${name}))) >= 3
      and (position(${normalized} in lower(trim(${name}))) > 0
        or position(lower(trim(${name})) in ${normalized}) > 0))
  )`;
  // Assignment alone is not provenance. Unknown/legacy assignments fail closed.
  const ownerAssigned = sql`(${issues.assigneeAgentId} is not null and exists (
    select 1 from activity_log assignment
    where assignment.company_id = ${companyId}
      and assignment.entity_type = 'issue' and assignment.entity_id = ${issues.id}::text
      and assignment.action in ('issue.created', 'issue.updated')
      and assignment.details ? 'assigneeAgentId'
      and assignment.actor_type = 'user'
      and assignment.details ->> 'assigneeAgentId' = ${issues.assigneeAgentId}::text
      and not exists (
        select 1 from activity_log newer
        where newer.company_id = assignment.company_id
          and newer.entity_type = 'issue' and newer.entity_id = assignment.entity_id
          and newer.action in ('issue.created', 'issue.updated')
          and newer.details ? 'assigneeAgentId'
          and (newer.created_at, newer.id) > (assignment.created_at, assignment.id)
      )
      and not exists (
        select 1 from issue_claims claim
        where claim.company_id = ${companyId} and claim.issue_id = ${issues.id}
          and claim.claimed_at >= assignment.created_at
      )
  ))`;
  return sql`(${ownerAssigned} or not exists (
    select 1 from issues current_issue
    join issue_labels current_link on current_link.issue_id = current_issue.id
      and current_link.company_id = ${companyId}
    join labels current_label on current_label.id = current_link.label_id
      and current_label.company_id = ${companyId}
    where current_issue.company_id = ${companyId}
      and current_issue.hidden_at is null
      and current_issue.status not in ('done', 'cancelled')
      and ${matches(sql`current_label.name`)}
  ) or exists (
    select 1 from issue_labels candidate_link
    join labels candidate_label on candidate_label.id = candidate_link.label_id
      and candidate_label.company_id = ${companyId}
    where candidate_link.company_id = ${companyId} and candidate_link.issue_id = ${issues.id}
      and ${matches(sql`candidate_label.name`)}
  ))`;
}
