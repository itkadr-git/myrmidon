// myrmidon(1.6.5 RUN-PRIORITY A): the process-wide in-force priority settings.
//
// A leaf module (imports only `@myrmidon/shared`) so the heartbeat sweeps
// can read it without pulling the services barrel. Startup and every
// settings write push into it (see service.ts); the sweeps read it fresh on
// every pass, so a changed weight reaches the queue without a restart —
// exactly the pattern of `applyRunAdmissionLimits`.

import {
  readRunPriorityFromEnv,
  normalizeRunPrioritySettings,
  storedRunPriorityDeclares,
  type RunPrioritySettings,
} from "@myrmidon/shared";

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

export type CompanyReleaseFocus = Pick<RunPrioritySettings, "currentRelease" | "strictReleaseFocus">;
let companyReleaseFocus = new Map<string, CompanyReleaseFocus>();

/** Replace the entire snapshot after re-reading the shared settings store. */
export function applyCompanyReleaseFocus(settings: ReadonlyMap<string, CompanyReleaseFocus>): void {
  companyReleaseFocus = new Map(settings);
}

/** A company without an explicit focus is not restricted by another company. */
export function currentCompanyReleaseFocus(companyId: string): CompanyReleaseFocus {
  return companyReleaseFocus.get(companyId) ?? { currentRelease: null, strictReleaseFocus: false };
}

export function companyReleaseFocusSnapshot(): ReadonlyMap<string, CompanyReleaseFocus> {
  return new Map(companyReleaseFocus);
}

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
  companyReleaseFocus.clear();
}
