// server/src/myrmidon/castes/resolve.ts
//
// myrmidon(1.6.5 F-26 T3 CASTES-AND-NESTS): the two ports the swarm matcher
// reads. This file is the CONTRACT between the matcher (T1, swarm-claim) and the
// caste directory (T3), and it is the only place where the swarm's caste rules
// are defined.
//
// Port 1 — which caste takes this task?
//   resolveTaskCaste(db, { companyId, issueId }) -> string
//   Three layers, first hit wins:
//     1. the task's own caste       (issues.caste_key, the pheromone column)
//     2. its project's default      (projects.default_caste_key)
//     3. the company's default      (agent_castes.is_default)
//   Layers 1 and 2 are the columns of the F-27 PHEROMONE part (T2, OPE-6614);
//   layer 3 is the flag this part adds. Nothing is hard-coded: `engineer` is not
//   a constant of the swarm any more, it is only the row the SEED flags when a
//   company is created (BUILTIN_CASTE_SEED_DEFAULT_KEY).
//
// Port 2 — where may this agent work?
//   agentNests(db, agentId) -> string[]
//   The project ids of the agent's nests. An empty list is the whole company.
//
// Both ports read the database on EVERY call: no row cache, no env, no
// in-process state. Moving the default radio, saving the agent's nests or
// reassigning a caste changes the next match without a restart.
//
// The same two rules are also exported as composable SQL fragments, because the
// queue read (T1's roleQueueRows) filters a whole page of candidate tasks in ONE
// query and cannot call a per-task function.

import { sql, type SQL } from "drizzle-orm";
import { notFound } from "../../errors.js";

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

export interface TaskCasteScope {
  companyId: string;
  issueId: string;
}

/**
 * One expression: the company's default caste key (agent_castes.is_default).
 * NULL when the company has no default row — the partial unique index allows at
 * most one, and the seed always writes one.
 */
export function companyDefaultCasteKeySql(companyId: string): SQL {
  return sql`(
    select d.key from agent_castes d
    where d.company_id = ${companyId} and d.is_default
    limit 1
  )`;
}

/**
 * One expression: the caste a task row resolves to, in the three layers of the
 * port. Pass the caller's own column expressions, e.g.
 *   taskCasteKeySql({ issueCasteKey: issues.casteKey,
 *                     projectDefaultKey: projects.defaultCasteKey,
 *                     companyId })
 * so the whole queue filter stays a single query.
 */
export function taskCasteKeySql(args: {
  issueCasteKey: SQL;
  projectDefaultKey: SQL;
  companyId: string;
}): SQL {
  return sql`coalesce(${args.issueCasteKey}, ${args.projectDefaultKey}, ${companyDefaultCasteKeySql(
    args.companyId,
  )})`;
}

/**
 * One boolean: may this agent take a task of that project? The rule of port 2
 * as a fragment — no nests means every project, and a task without a project is
 * always allowed.
 */
export function agentNestsAllowSql(args: {
  agentId: SQL | string;
  projectId: SQL;
}): SQL {
  const agent = typeof args.agentId === "string" ? sql`${args.agentId}` : args.agentId;
  return sql`(
    not exists (select 1 from agent_nests n where n.agent_id = ${agent})
    or ${args.projectId} is null
    or exists (
      select 1 from agent_nests n
      where n.agent_id = ${agent} and n.project_id = ${args.projectId}
    )
  )`;
}

/**
 * Port 1: the caste that takes a task. Layers of the header, first hit wins.
 * The task's own row decides the first layer, so a missing task is a 404 and
 * not a silent fallback — the matcher's single-query path is the fragment
 * above, this function serves the per-task callers.
 */
export async function resolveTaskCaste(
  db: { execute: (query: SQL) => Promise<unknown> },
  scope: TaskCasteScope,
): Promise<string> {
  const result = await db.execute(sql`
    select coalesce(i.caste_key, p.default_caste_key, d.key, f.key) as caste_key
    from issues i
    left join projects p on p.id = i.project_id
    left join agent_castes d on d.company_id = i.company_id and d.is_default
    left join lateral (
      select k.key from agent_castes k
      where k.company_id = i.company_id
      order by k.key
      limit 1
    ) f on true
    where i.id = ${scope.issueId} and i.company_id = ${scope.companyId}
  `);
  const row = rowsOf<{ caste_key: string | null }>(result)[0];
  if (!row) {
    throw notFound(`Issue ${scope.issueId} not found in this company`);
  }
  if (row.caste_key === null) {
    // Only reachable when the company directory is empty (every caste deleted);
    // the seed refills the directory on the next read, so the matcher never
    // sees this in practice.
    throw notFound(`No caste resolves for issue ${scope.issueId}`, {
      code: "caste_dir_empty",
    });
  }
  return row.caste_key;
}

/**
 * Port 2: the agent's nests. Empty array = the whole company (the agent is
 * eligible for every project). Fresh read on every call.
 */
export async function agentNests(
  db: { execute: (query: SQL) => Promise<unknown> },
  agentId: string,
): Promise<string[]> {
  const result = await db.execute(sql`
    select n.project_id
    from agent_nests n
    where n.agent_id = ${agentId}
    order by n.created_at, n.project_id
  `);
  return rowsOf<{ project_id: string }>(result).map((row) => row.project_id);
}