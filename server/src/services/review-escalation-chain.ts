// myrmidon(OPE-9031): the default review escalation chain.
//
// When review rounds run out and the task has no `reviewEscalationPolicy`, the
// stage goes to a senior AGENT, never to a human:
//   1. the current reviewer's manager (`agents.reports_to`), then upward;
//   2. the project lead (`projects.lead_agent_id`);
//   3. the company's top agent `adm` (no `reports_to`).
// Skipped: the current reviewer, the executor (`returnAssignee`), paused and
// terminated agents. An empty result means "no one": the transition raises a
// recovery card instead.
//
// `issue-execution-policy.ts` stays synchronous and DB-free; the callers of
// `applyIssueExecutionPolicyTransition` that can produce a changes-requested
// outcome call `withDefaultEscalationChain` first and pass the ids in
// `issue.defaultEscalationAgentIds`.

import { and, eq } from "drizzle-orm";
import { agents, projects } from "@myrmidon/db";
import type { Db } from "@myrmidon/db";
import type { IssueExecutionPolicy } from "@myrmidon/shared";
import { mayNeedDefaultEscalationChain, parseIssueExecutionState } from "./issue-execution-policy.js";

export interface EscalationAgentRow {
  id: string;
  name: string;
  status: string;
  reportsTo: string | null;
  pausedAt: Date | string | null;
}

const ROOT_AGENT_NAME = "adm";
const MAX_DEPTH = 32;

function isEligible(agent: EscalationAgentRow): boolean {
  return agent.status !== "paused" && agent.status !== "terminated" && !agent.pausedAt;
}

/** Pure: the ordered candidate ids. */
export function buildSeniorChain(input: {
  agents: EscalationAgentRow[];
  reviewerAgentId: string | null;
  projectLeadAgentId: string | null;
  returnAssigneeAgentId: string | null;
}): string[] {
  const byId = new Map(input.agents.map((agent) => [agent.id, agent]));
  const out: string[] = [];
  const push = (id: string | null | undefined) => {
    if (!id || out.includes(id)) return;
    if (id === input.reviewerAgentId || id === input.returnAssigneeAgentId) return;
    const agent = byId.get(id);
    if (!agent || !isEligible(agent)) return;
    out.push(id);
  };
  // 1. managers of the reviewer, upward (a paused manager is skipped, the walk continues).
  const seen = new Set<string>();
  let cursor = input.reviewerAgentId ? byId.get(input.reviewerAgentId)?.reportsTo ?? null : null;
  for (let depth = 0; cursor && depth < MAX_DEPTH && !seen.has(cursor); depth += 1) {
    seen.add(cursor);
    push(cursor);
    cursor = byId.get(cursor)?.reportsTo ?? null;
  }
  // 2. the project lead.
  push(input.projectLeadAgentId);
  // 3. the top agent `adm`.
  push(input.agents.find((agent) => agent.reportsTo == null && agent.name.trim().toLowerCase() === ROOT_AGENT_NAME)?.id);
  return out;
}

export async function resolveDefaultEscalationAgentIds(
  db: Db,
  issue: { companyId: string; projectId?: string | null; executionState?: unknown; assigneeAgentId?: string | null },
): Promise<string[]> {
  const state = parseIssueExecutionState(issue.executionState ?? null);
  const reviewer = state?.currentParticipant;
  const reviewerAgentId = reviewer?.type === "agent" ? reviewer.agentId ?? null : issue.assigneeAgentId ?? null;
  const returnAssignee = state?.returnAssignee;
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      status: agents.status,
      reportsTo: agents.reportsTo,
      pausedAt: agents.pausedAt,
    })
    .from(agents)
    .where(eq(agents.companyId, issue.companyId));
  let projectLeadAgentId: string | null = null;
  if (issue.projectId) {
    const [project] = await db
      .select({ leadAgentId: projects.leadAgentId })
      .from(projects)
      .where(and(eq(projects.id, issue.projectId), eq(projects.companyId, issue.companyId)));
    projectLeadAgentId = project?.leadAgentId ?? null;
  }
  return buildSeniorChain({
    agents: rows,
    reviewerAgentId,
    projectLeadAgentId,
    returnAssigneeAgentId: returnAssignee?.type === "agent" ? returnAssignee.agentId ?? null : null,
  });
}

/**
 * The shared entry point for the transition callers: returns `issue` with
 * `defaultEscalationAgentIds` filled when the round limit can trigger without
 * a configured escalation policy, and the same object otherwise (no query).
 */
export async function withDefaultEscalationChain<
  T extends { companyId: string; projectId?: string | null; executionState?: unknown; assigneeAgentId?: string | null },
>(
  db: Db,
  issue: T,
  policy: IssueExecutionPolicy | null,
): Promise<T & { defaultEscalationAgentIds?: string[] }> {
  if (!mayNeedDefaultEscalationChain(issue as never, policy)) return issue;
  return { ...issue, defaultEscalationAgentIds: await resolveDefaultEscalationAgentIds(db, issue) };
}
