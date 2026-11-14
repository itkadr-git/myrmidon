import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { agents, projects } from "@myrmidon/db";
import { isAgentStatusInvokable } from "@myrmidon/shared";
import { resolveCompanyDomainHeadId } from "../../services/responsible-head.js";

type DbReader = Pick<Db, "select">;

export async function resolvePlanApprovalRecipient(
  db: DbReader,
  companyId: string,
  projectId: string | null | undefined,
  executorAgentId: string | null | undefined,
): Promise<string | null> {
  if (projectId) {
    const [project] = await db
      .select({ leadAgentId: projects.leadAgentId })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .limit(1);
    if (project?.leadAgentId && project.leadAgentId !== executorAgentId) {
      const [lead] = await db
        .select({ id: agents.id, status: agents.status, pausedAt: agents.pausedAt })
        .from(agents)
        .where(and(eq(agents.id, project.leadAgentId), eq(agents.companyId, companyId)))
        .limit(1);
      if (
        lead &&
        isAgentStatusInvokable(lead.status) &&
        !lead.pausedAt &&
        lead.status !== "paused" &&
        lead.status !== "terminated"
      ) {
        return lead.id;
      }
    }
  }

  // Fallback to adm agent
  const candidates = await db
    .select({ id: agents.id, name: agents.name, status: agents.status, pausedAt: agents.pausedAt })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        ne(agents.status, "terminated"),
        ne(agents.status, "paused"),
      ),
    );
  const adm = candidates.find(
    (a) =>
      a.id !== executorAgentId &&
      isAgentStatusInvokable(a.status) &&
      !a.pausedAt &&
      a.name.trim().toLowerCase() === "adm",
  );
  if (adm) return adm.id;

  const domainHead = await resolveCompanyDomainHeadId(db, companyId);
  if (domainHead && domainHead !== executorAgentId) return domainHead;

  return null;
}
