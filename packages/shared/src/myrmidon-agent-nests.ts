// packages/shared/src/myrmidon-agent-nests.ts
//
// myrmidon(1.6.5 F-26 T3 CASTES-AND-NESTS): the agent nests contract — the
// projects an agent is willing to work in.
//
// Semantics (design.md §2.2, §7.2), one rule with two cases:
//
//  - `nests` empty            -> the agent is a citizen of the whole company:
//                               eligible for every task;
//  - `nests` non-empty        -> the agent is eligible for the tasks of those
//                               projects AND for the tasks that belong to no
//                               project at all (project_id IS NULL), because a
//                               project-less task cannot contradict a nest.
//
// Pure data and one pure predicate only — no database, no cache. The server
// reads the pairs fresh on every matcher pass (server/src/myrmidon/castes/
// nests-store.ts and resolve.ts), so saving the multi-select in the agent card
// changes the match without a restart. This file is the single source of truth for the API shape,
// the UI field and the matcher's predicate.

import { z } from "zod";

/** Upper bound of the multi-select; a company with more projects than this is
 *  out of scope, and the cap keeps the PUT body and the IN-list bounded. */
export const AGENT_NESTS_MAX_PROJECTS = 200;

/**
 * PUT /api/myrmidon/companies/:companyId/agents/:agentId/nests body.
 * An empty array is the explicit "the whole company" and clears the nests.
 */
export const agentNestsBodySchema = z.object({
  projectIds: z
    .array(z.string().uuid())
    .max(AGENT_NESTS_MAX_PROJECTS)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "projectIds must not contain duplicates",
    }),
});
export type AgentNestsBody = z.infer<typeof agentNestsBodySchema>;

/** GET/PUT answer: the agent's current nests. */
export interface AgentNestsView {
  companyId: string;
  agentId: string;
  /** Project ids; empty = the whole company. */
  projectIds: string[];
}

/**
 * The matcher's predicate, pure so both the SQL leg (nests.ts fragment) and the
 * row leg use one definition of the rule. `nests` empty allows everything; a
 * task without a project is allowed for a nested agent.
 */
export function agentNestAllowsProject(
  nests: readonly string[],
  projectId: string | null | undefined,
): boolean {
  if (nests.length === 0) return true;
  if (projectId === null || projectId === undefined) return true;
  return nests.includes(projectId);
}