import { runOnboardOnce } from "./runner.js";

/** Process one job using the deployment's configured board and company. */
export async function runOnboardFromEnvironment(env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch): Promise<boolean> {
  const baseUrl = env.MYRMIDON_FLEET_ONBOARD_BASE_URL?.trim();
  const companyId = env.MYRMIDON_FLEET_ONBOARD_COMPANY_ID?.trim();
  const token = env.MYRMIDON_FLEET_ONBOARD_EXECUTOR_TOKEN?.trim();
  if (!baseUrl || !companyId || !token) throw new Error("Missing fleet onboarding configuration");
  return runOnboardOnce({ baseUrl, companyId, token, fetcher });
}
