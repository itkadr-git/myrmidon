// server/src/myrmidon/castes/nests-service.ts
//
// myrmidon(1.6.5 F-26 T3 CASTES-AND-NESTS): the rules of the agent nests — an
// agent exists in this company, every chosen project exists in this company,
// and the stored set is exactly what the card showed.
//
// Nothing here is a swarm rule: the matcher reads the pairs through port 2
// (`agentNests` / `agentNestsAllowSql` in resolve.ts).

import { and, eq } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import type { AgentNestsView } from "@paperclipai/shared";
import { badRequest, notFound } from "../../errors.js";
import type { AgentNestStore } from "./nests-store.js";

export interface AgentNestServiceDeps {
  db: Db;
  store: AgentNestStore;
}

/** What one PUT changed — the audit row of the nests. */
export interface AgentNestsChange {
  view: AgentNestsView;
  added: string[];
  removed: string[];
}

export function createAgentNestService(deps: AgentNestServiceDeps) {
  async function assertAgent(companyId: string, agentId: string): Promise<void> {
    const [row] = await deps.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .limit(1);
    if (!row) throw notFound(`Agent ${agentId} not found in this company`);
  }

  /** The agent's nests as the agent card shows them. */
  async function getNests(companyId: string, agentId: string): Promise<AgentNestsView> {
    await assertAgent(companyId, agentId);
    const projectIds = await deps.store.listNests(companyId, agentId);
    return { companyId, agentId, projectIds };
  }

  /**
   * Saves the multi-select. An empty list means "the whole company" (no rows),
   * which is the state of a fresh agent. Unknown project ids are refused as a
   * whole, so a typo never clears a nest silently.
   */
  async function putNests(args: {
    companyId: string;
    agentId: string;
    projectIds: string[];
  }): Promise<AgentNestsChange> {
    const { companyId, agentId } = args;
    await assertAgent(companyId, agentId);
    const wanted = [...new Set(args.projectIds)];
    const known = await deps.store.knownProjectIds(companyId, wanted);
    const unknown = wanted.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw badRequest("Unknown projects for this company", { unknownProjectIds: unknown });
    }
    const before = await deps.store.listNests(companyId, agentId);
    const projectIds = await deps.store.replaceNests(companyId, agentId, wanted);
    return {
      view: { companyId, agentId, projectIds },
      added: projectIds.filter((id) => !before.includes(id)),
      removed: before.filter((id) => !projectIds.includes(id)),
    };
  }

  return { getNests, putNests };
}

export type AgentNestService = ReturnType<typeof createAgentNestService>;