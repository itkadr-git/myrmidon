// myrmidon(1.6-SWARM-CLAIM-B): settings of the supervisor surface.
//
// Part B (the supervisor view and the rebalance action) owns its own knob.
// The claim machinery itself — the queue, the lease, the TTL, the per-agent
// limit and the master switch — belongs to part A and is read from there;
// this module never invents a second copy of those keys.
//
// The style follows the rest of the 1.6 modules: a numeric setting falls back
// to its default on anything that is not a positive integer.

/** How many queue candidates one role may report; a ceiling, not a page size. */
export const SWARM_SUPERVISOR_TASK_MAX_ENV = "MYRMIDON_SWARM_SUPERVISOR_TASK_MAX";
export const DEFAULT_SWARM_SUPERVISOR_TASK_MAX = 500;

/**
 * Upper bound of the row cap: a caller cannot turn the overview into an
 * unbounded scan by setting a huge value. The default is already 500 roles
 * worth of rows; the ceiling only exists so a typo cannot ask for millions.
 */
export const MAX_SWARM_SUPERVISOR_TASK_MAX = 5000;

export interface SwarmSupervisorSettings {
  /** Rows of queue candidates per role in the overview. */
  taskMax: number;
}

export function readSwarmSupervisorSettings(
  env: NodeJS.ProcessEnv = process.env,
): SwarmSupervisorSettings {
  return {
    taskMax: readTaskMax(env),
  };
}

function readTaskMax(env: NodeJS.ProcessEnv): number {
  const raw = env[SWARM_SUPERVISOR_TASK_MAX_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_SWARM_SUPERVISOR_TASK_MAX;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return DEFAULT_SWARM_SUPERVISOR_TASK_MAX;
  return Math.min(value, MAX_SWARM_SUPERVISOR_TASK_MAX);
}