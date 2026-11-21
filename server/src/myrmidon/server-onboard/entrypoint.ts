import { setTimeout as delay } from "node:timers/promises";
import { runOnboardOnce } from "./runner.js";

/** Process one job using the deployment's configured board and company. */
export async function runOnboardFromEnvironment(env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch): Promise<boolean> {
  const baseUrl = env.MYRMIDON_FLEET_ONBOARD_BASE_URL?.trim();
  const companyId = env.MYRMIDON_FLEET_ONBOARD_COMPANY_ID?.trim();
  const token = env.MYRMIDON_FLEET_ONBOARD_EXECUTOR_TOKEN?.trim();
  if (!baseUrl || !companyId || !token) throw new Error("Missing fleet onboarding configuration");
  return runOnboardOnce({ baseUrl, companyId, token, fetcher, bootstrap: {
    skipMonitoring: env.MYRMIDON_FLEET_ONBOARD_SKIP_MONITORING === "true",
    skipRoleBootstrap: env.MYRMIDON_FLEET_ONBOARD_SKIP_ROLE_BOOTSTRAP === "true",
  } });
}

export async function runOnboardWorker(env: NodeJS.ProcessEnv, options: { fetcher?: typeof fetch; signal: AbortSignal; pollMs?: number }): Promise<void> {
  while (!options.signal.aborted) {
    const claimed = await runOnboardFromEnvironment(env, options.fetcher);
    if (!claimed && !options.signal.aborted) {
      try { await delay(options.pollMs ?? 5000, undefined, { signal: options.signal }); }
      catch (error) { if (!options.signal.aborted) throw error; }
    }
  }
}
