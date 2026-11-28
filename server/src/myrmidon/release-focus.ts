import { and, eq, sql, type SQL } from "drizzle-orm";
import { issues, type Db } from "@myrmidon/db";
import { currentCompanyReleaseFocus } from "./run-priority/state.js";

/**
 * The release the board is focused on, or null when focus is off: either no
 * current release is set or the owner turned runPriority.strictReleaseFocus
 * off. Read live from the in-force settings, so a settings change applies
 * without a restart. Swarm matcher, idle pickup and the run-start gate all
 * gate on it. When every current-release task is blocked or in review, focus
 * stays active on purpose: the operator lifts it with the setting.
 */
export function strictReleaseFocusRelease(companyId: string): string | null {
  const settings = currentCompanyReleaseFocus(companyId);
  if (!settings.strictReleaseFocus) return null;
  return settings.currentRelease?.trim() ? settings.currentRelease : null;
}

/**
 * A label name that looks like a release number (`1.8`, `1.6.9`). Only such a
 * label marks a task as belonging to a release; `bug`, `ops` and the like do not.
 */
const RELEASE_LABEL_PATTERN = String.raw`^\d+\.\d+(\.\d+)?$`;

/**
 * Strict focus blocks a task only when it carries a release label of ANOTHER
 * release. A task without a release label (operations, business bots, leads) and
 * a task with the current release label pass; so does a task with both.
 * Shared by swarm queue reads and assigned-task idle pickup; reviews bypass it.
 */
export function releaseFocusCondition(companyId: string): SQL {
  const release = strictReleaseFocusRelease(companyId);
  if (!release) return sql`true`;
  const normalized = release.trim().toLowerCase();
  const matches = (name: SQL) => sql`lower(trim(${name})) = ${normalized}`;
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
  ) or not exists (
    select 1 from issue_labels other_link
    join labels other_label on other_label.id = other_link.label_id
      and other_label.company_id = ${companyId}
    where other_link.company_id = ${companyId} and other_link.issue_id = ${issues.id}
      and trim(other_label.name) ~ ${RELEASE_LABEL_PATTERN}
      and not (${matches(sql`other_label.name`)})
  ))`;
}

/**
 * The run-start gate (called from `claimQueuedRun`, the one place every queued
 * run passes). True when strict focus is active, the run's task is not part of
 * the current release (same predicate as `releaseFocusCondition`, company
 * scoped) and the owner did not assign it by hand. A review the agent is the
 * current participant of passes, as in idle pickup. Runs without a task and
 * tasks that no longer exist pass.
 */
export async function runViolatesReleaseFocus(
  db: Db,
  input: { companyId: string; agentId: string; issueId: string | null },
): Promise<boolean> {
  if (!input.issueId || !strictReleaseFocusRelease(input.companyId)) return false;
  const reviewParticipant = sql`(${issues.status} = 'in_review'
    and ${issues.executionState} -> 'currentParticipant' ->> 'type' = 'agent'
    and ${issues.executionState} -> 'currentParticipant' ->> 'agentId' = ${input.agentId})`;
  const [row] = await db
    .select({ allowed: sql<boolean>`(${releaseFocusCondition(input.companyId)}) or ${reviewParticipant}` })
    .from(issues)
    .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
    .limit(1);
  return row !== undefined && row.allowed !== true;
}
