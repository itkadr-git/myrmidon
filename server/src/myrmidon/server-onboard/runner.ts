import { FleetOnboardExecutor } from "./executor.js";
import type { OnboardJobClaim } from "./store.js";

type RunnerOptions = { baseUrl: string; companyId: string; token: string; fetcher?: typeof fetch };

/** Claim and execute one job; the transport verifies host identity before authentication. */
export async function runOnboardOnce(options: RunnerOptions): Promise<boolean> {
  const fetcher = options.fetcher ?? fetch;
  const base = `${options.baseUrl.replace(/\/$/, "")}/api/myrmidon/fleet/onboard-jobs`;
  async function post(path: string, body: unknown): Promise<Response> {
    const response = await fetcher(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-onboard-token": options.token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Onboarding API request failed: ${response.status}`);
    return response;
  }
  const response = await post("/claim", { companyId: options.companyId });
  if (response.status === 204) return false;
  const claim = await response.json() as OnboardJobClaim & { secretValues: Record<string, string> };
  const jobPath = `/${encodeURIComponent(claim.job.id)}`;
  const executor = new FleetOnboardExecutor();
  await executor.execute(claim, {
    async pinHostKey(fingerprint) {
      try {
        const response = await post(`${jobPath}/host-key`, { companyId: options.companyId, fingerprint });
        const result: unknown = await response.json();
        return typeof result === "object" && result !== null && "accepted" in result && result.accepted === true;
      } catch { return false; }
    },
    async reportStep(step, result, detail) {
      await post(`${jobPath}/report`, { companyId: options.companyId, step, result, detail });
    },
    async reportCompletion(status, error, hostKeyFingerprint) {
      await post(`${jobPath}/report`, { companyId: options.companyId, status, error, hostKeyFingerprint });
    },
  });
  return true;
}
