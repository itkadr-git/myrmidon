// server/src/myrmidon/castes/nests-store.ts
//
// myrmidon(1.6.5 F-26 T3 CASTES-AND-NESTS): the database side of the agent
// nests (table agent_nests, migration 0385).
//
// Liveness (owner's criterion, same as the caste store): the pairs are read from
// the database on every call — no read cache, no env. Saving the multi-select in
// the agent card is visible to the matcher on its next pass.
//
// `replaceNests` is one transaction (delete the agent's pairs, insert the new
// set), so a PUT can never leave the agent with half a nest and a concurrent
// matcher pass sees either the old or the new set.

import { and, asc, eq, inArray } from "drizzle-orm";
import { agentNests, projects, type Db } from "@paperclipai/db";

export interface AgentNestStoreDeps {
  db: Db;
}

export function createAgentNestStore(deps: AgentNestStoreDeps) {
  /** The agent's nests as project ids, ordered (stable for the UI and tests). */
  async function listNests(companyId: string, agentId: string): Promise<string[]> {
    const rows = await deps.db
      .select({ projectId: agentNests.projectId })
      .from(agentNests)
      .where(and(eq(agentNests.companyId, companyId), eq(agentNests.agentId, agentId)))
      .orderBy(asc(agentNests.projectId));
    return rows.map((row) => row.projectId);
  }

  /** The project ids of the company that exist — the guard of a PUT body. */
  async function knownProjectIds(companyId: string, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await deps.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), inArray(projects.id, ids)));
    return new Set(rows.map((row) => row.id));
  }

  /**
   * Replaces the agent's nests with `projectIds` in one transaction. An empty
   * list clears the nests — "the whole company" is the absence of rows, never a
   * row per project.
   */
  async function replaceNests(
    companyId: string,
    agentId: string,
    projectIds: string[],
  ): Promise<string[]> {
    await deps.db.transaction(async (tx) => {
      await tx
        .delete(agentNests)
        .where(and(eq(agentNests.companyId, companyId), eq(agentNests.agentId, agentId)));
      if (projectIds.length === 0) return;
      await tx
        .insert(agentNests)
        .values(
          projectIds.map((projectId) => ({ companyId, agentId, projectId })),
        )
        // The unique (agent_id, project_id) index backstops a concurrent PUT of
        // the same set; the caller's dedupe already removed duplicates.
        .onConflictDoNothing({ target: [agentNests.agentId, agentNests.projectId] });
    });
    return listNests(companyId, agentId);
  }

  return { listNests, knownProjectIds, replaceNests };
}

export type AgentNestStore = ReturnType<typeof createAgentNestStore>;