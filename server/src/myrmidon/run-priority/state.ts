// myrmidon(1.6.5 RUN-PRIORITY A): the process-wide in-force priority settings.
//
// A leaf module (imports only `@paperclipai/shared`) so the heartbeat sweeps
// can read it without pulling the services barrel. Startup and every
// settings write push into it (see service.ts); the sweeps read it fresh on
// every pass, so a changed weight reaches the queue without a restart —
// exactly the pattern of `applyRunAdmissionLimits`.

import {
  readRunPriorityFromEnv,
  normalizeRunPrioritySettings,
  storedRunPriorityDeclares,
  type RunPrioritySettings,
} from "@paperclipai/shared";

export interface RunPriorityView {
  settings: RunPrioritySettings;
  /** Where the settings came from: the stored row or the environment/defaults. */
  source: "settings" | "env";
}

/**
 * Resolve the settings for a stored row: the row's keys beat the environment,
 * the environment beats the built-in defaults (the per-key fallback inside
 * `normalizeRunPrioritySettings` does exactly that).
 */
export function resolveRunPriority(
  stored: unknown,
  env: Record<string, string | undefined> = process.env,
): RunPriorityView {
  const fromEnv = readRunPriorityFromEnv(env);
  const settings = normalizeRunPrioritySettings(stored, fromEnv);
  return { settings, source: storedRunPriorityDeclares(stored) ? "settings" : "env" };
}

let inForce: RunPrioritySettings | null = null;

/** Put settings in force for the live queue sweeps. */
export function applyRunPrioritySettings(settings: RunPrioritySettings): void {
  inForce = settings;
}

/**
 * The settings a sweep scores with right now. Before startup put the stored
 * row in force (a unit test, a route call before boot), the environment and
 * the defaults apply — and a broken read must never take the sweep down:
 * priority scoring failing means FIFO, not a dead heartbeat.
 */
export function currentRunPrioritySettings(
  env: Record<string, string | undefined> = process.env,
): RunPrioritySettings {
  if (inForce) return inForce;
  try {
    return resolveRunPriority(undefined, env).settings;
  } catch {
    return readRunPriorityFromEnv({});
  }
}

/** Test hook: drop the in-force settings so the next read falls back again. */
export function resetRunPriorityForTests(): void {
  inForce = null;
}
