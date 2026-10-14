// myrmidon(1.6.5 F-26 T3 CASTES-AND-NESTS): the per-caste counters of the
// "Agent castes" screen — "agents / queue / free now".
//
// Until the supervisor overview (F-26 T4) exposes its endpoint these come from
// the two lists a company already loads:
//   agents — the roster the company list returns (all statuses but terminated);
//   queue  — the tasks the caller read with status `todo` (nobody on them);
//   free   — roster agents of the caste that are not holding a task, i.e. their
//            own status is `active`/`idle` (a busy agent is `running`).
//
// A queued task that names no caste belongs to the company default, which is
// exactly the rule of matcher port 1 (resolveTaskCaste). `casteKey` arrives with
// F-27 T2 and is read defensively: a task list without the field still counts,
// with everything landing on the default caste.
import type { CasteView } from "./castesApi";

export interface CasteCounts {
  agents: number;
  queued: number;
  free: number;
}

export interface CasteCountsAgent {
  id: string;
  role: string;
  status: string;
}

export interface CasteCountsTask {
  assigneeAgentId?: string | null;
  casteKey?: string | null;
}

/** Everyone but a terminated agent is part of the roster. */
const ROSTER_STATUSES = new Set([
  "active",
  "idle",
  "running",
  "paused",
  "error",
  "pending_approval",
]);

/** An agent holding a task reports `running`; these two are free right now. */
const FREE_STATUSES = new Set(["active", "idle"]);

export function casteCounts(
  castes: CasteView[],
  agents: CasteCountsAgent[],
  queuedTasks: CasteCountsTask[],
): Record<string, CasteCounts> {
  const defaultKey = castes.find((caste) => caste.isDefault)?.key ?? null;
  const roster = agents.filter((agent) => ROSTER_STATUSES.has(agent.status));

  const counts: Record<string, CasteCounts> = {};
  for (const caste of castes) {
    const ofCaste = roster.filter((agent) => agent.role === caste.key);
    counts[caste.key] = {
      agents: ofCaste.length,
      queued: queuedTasks.filter(
        (task) =>
          (task.assigneeAgentId ?? null) === null &&
          (task.casteKey ?? defaultKey) === caste.key,
      ).length,
      free: ofCaste.filter((agent) => FREE_STATUSES.has(agent.status)).length,
    };
  }
  return counts;
}