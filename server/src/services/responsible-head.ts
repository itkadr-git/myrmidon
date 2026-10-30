import { and, asc, eq, isNull, ne } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { agents, projects } from "@myrmidon/db";
import { isAgentStatusInvokable } from "@myrmidon/shared";

type DbReader = Pick<Db, "select">;

const KNOWN_HEAD_NAMES = ["adm", "bbq", "work", "life", "dispatch"];

/**
 * Traverses reportsTo up the hierarchy starting from the given agent ID
 * to find the top-level agent (where reportsTo is null).
 * Returns null if the root agent is non-invokable (e.g. paused or terminated).
 */
export async function resolveAgentHeadId(
  reader: DbReader,
  companyId: string,
  startAgentId: string,
): Promise<string | null> {
  let currentId: string | null = startAgentId;
  const visited = new Set<string>();

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const [agent] = await reader
      .select({
        id: agents.id,
        reportsTo: agents.reportsTo,
        status: agents.status,
      })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, currentId)));

    if (!agent) {
      return null;
    }

    if (!agent.reportsTo) {
      if (!isAgentStatusInvokable(agent.status)) {
        return null;
      }
      return agent.id;
    }

    currentId = agent.reportsTo;
  }

  return null;
}

/**
 * Finds the domain company head: an active root agent (reportsTo IS NULL),
 * prioritizing known head names ('adm', 'bbq', 'work', 'life', 'dispatch'),
 * or the earliest created root agent.
 */
export async function resolveCompanyDomainHeadId(
  reader: DbReader,
  companyId: string,
): Promise<string | null> {
  const rootAgents = await reader
    .select({
      id: agents.id,
      name: agents.name,
      status: agents.status,
      createdAt: agents.createdAt,
    })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        isNull(agents.reportsTo),
        ne(agents.status, "terminated"),
        ne(agents.status, "paused"),
      ),
    )
    .orderBy(asc(agents.createdAt));

  const invokable = rootAgents.filter((a) => isAgentStatusInvokable(a.status));
  if (invokable.length === 0) {
    return null;
  }

  // Exact match on known head names
  for (const known of KNOWN_HEAD_NAMES) {
    const match = invokable.find(
      (a) => a.name.trim().toLowerCase() === known,
    );
    if (match) return match.id;
  }

  // Prefix match on known head names
  for (const known of KNOWN_HEAD_NAMES) {
    const match = invokable.find(
      (a) => a.name.trim().toLowerCase().startsWith(known),
    );
    if (match) return match.id;
  }

  // Fallback to earliest created active root agent
  return invokable[0]?.id ?? null;
}

/**
 * Resolves the responsible head agent for an issue:
 * 1. If assigneeAgentId is given: root of reportsTo chain.
 * 2. If unassigned:
 *    a. If projectId is given: root of project.leadAgentId's reportsTo chain.
 *    b. Fallback: root of createdByAgentId (if agent).
 *    c. Company-domain head (active root agent in company, e.g. adm, bbq, etc.).
 */
export async function resolveResponsibleHeadAgentId(
  reader: DbReader,
  companyId: string,
  options: {
    assigneeAgentId?: string | null;
    projectId?: string | null;
    createdByAgentId?: string | null;
  },
): Promise<string | null> {
  if (options.assigneeAgentId) {
    const head = await resolveAgentHeadId(reader, companyId, options.assigneeAgentId);
    if (head) return head;
  }

  if (options.projectId) {
    const [project] = await reader
      .select({ leadAgentId: projects.leadAgentId })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), eq(projects.id, options.projectId)));

    if (project?.leadAgentId) {
      const head = await resolveAgentHeadId(reader, companyId, project.leadAgentId);
      if (head) return head;
    }
  }

  if (options.createdByAgentId) {
    const head = await resolveAgentHeadId(reader, companyId, options.createdByAgentId);
    if (head) return head;
  }

  const domainHead = await resolveCompanyDomainHeadId(reader, companyId);
  if (domainHead) return domainHead;

  return null;
}
