import { describe, expect, it } from "vitest";
import { runOnboardFromEnvironment, runOnboardWorker } from "./entrypoint.js";

describe("onboarding production entrypoint", () => {
  it("continues polling after an empty queue and stops when aborted", async () => {
    const controller = new AbortController();
    let claims = 0;
    const fetcher: typeof fetch = async () => {
      claims++;
      if (claims === 2) controller.abort();
      return new Response(null, { status: 204 });
    };
    await runOnboardWorker({ MYRMIDON_FLEET_ONBOARD_BASE_URL: "https://board.example", MYRMIDON_FLEET_ONBOARD_COMPANY_ID: "company", MYRMIDON_FLEET_ONBOARD_EXECUTOR_TOKEN: "token" }, { fetcher, signal: controller.signal, pollMs: 1 });
    expect(claims).toBe(2);
  });
  it("claims a job using the configured board and company", async () => {
    const requests: Array<{ url: string; body: unknown; token: string | null }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)), token: new Headers(init?.headers).get("x-onboard-token") });
      return new Response(null, { status: 204 });
    };
    expect(await runOnboardFromEnvironment({
      MYRMIDON_FLEET_ONBOARD_BASE_URL: "https://board.example",
      MYRMIDON_FLEET_ONBOARD_COMPANY_ID: "company",
      MYRMIDON_FLEET_ONBOARD_EXECUTOR_TOKEN: "token",
    }, fetcher)).toBe(false);
    expect(requests).toEqual([{ url: "https://board.example/api/myrmidon/fleet/onboard-jobs/claim", body: { companyId: "company" }, token: "token" }]);
  });

  it("rejects missing configuration before contacting the board", async () => {
    let contacted = false;
    const fetcher: typeof fetch = async () => { contacted = true; return new Response(null, { status: 204 }); };
    await expect(runOnboardFromEnvironment({}, fetcher)).rejects.toThrow("Missing fleet onboarding configuration");
    expect(contacted).toBe(false);
  });
});
