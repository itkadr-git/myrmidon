// myrmidon(SERVER-ONBOARD A): settings (MYRMIDON_FLEET_ONBOARD_*).
//
// Off by default: without MYRMIDON_FLEET_ONBOARD_ENABLED=1 the add-server
// form's write routes answer 503 with a clear message, exactly like the
// deploy-from-UI feature. Nothing else changes on an instance that never
// opted in.

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

function readBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

export interface FleetOnboardSettings {
  /** Master switch; off means the onboard write API answers 503. */
  enabled: boolean;
  /** One job step may take this long before the job is expired. */
  stepTimeoutMs: number;
  /** How often the sweep expires abandoned jobs and refreshes servers. */
  tickMs: number;
  /** Shared secret the fleet-onboard executor presents to claim/report. */
  executorToken: string | null;
  /** Password may be kept in the secret store instead of discarded. */
  allowKeepPassword: boolean;
}

export function readFleetOnboardSettings(env: NodeJS.ProcessEnv = process.env): FleetOnboardSettings {
  return {
    enabled: readBool(env, "MYRMIDON_FLEET_ONBOARD_ENABLED", false),
    stepTimeoutMs: readInt(env, "MYRMIDON_FLEET_ONBOARD_STEP_TIMEOUT_SEC", 1800, 30, 86_400) * 1000,
    tickMs: readInt(env, "MYRMIDON_FLEET_ONBOARD_TICK_SEC", 60, 5, 3600) * 1000,
    executorToken: env.MYRMIDON_FLEET_ONBOARD_EXECUTOR_TOKEN?.trim() || null,
    allowKeepPassword: readBool(env, "MYRMIDON_FLEET_ONBOARD_KEEP_PASSWORD", true),
  };
}
