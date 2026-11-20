import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runOnboardFromEnvironment, runOnboardWorker } from "./entrypoint.js";

describe("onboarding production entrypoint", () => {
  it("starts the worker process and claims from the configured board", async () => {
    let claimed!: () => void;
    const received = new Promise<void>((resolve) => { claimed = resolve; });
    const board = createServer((req, res) => {
      if (req.url === "/api/myrmidon/fleet/onboard-jobs/claim" && req.headers["x-onboard-token"] === "test-token") claimed();
      res.writeHead(204).end();
    });
    await new Promise<void>((resolve) => board.listen(0, "127.0.0.1", resolve));
    const address = board.address();
    if (!address || typeof address === "string") throw new Error("missing board address");
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./worker.ts", import.meta.url))], {
      env: { ...process.env, MYRMIDON_FLEET_ONBOARD_BASE_URL: `http://127.0.0.1:${address.port}`, MYRMIDON_FLEET_ONBOARD_COMPANY_ID: "company", MYRMIDON_FLEET_ONBOARD_EXECUTOR_TOKEN: "test-token" },
      stdio: "ignore",
    });
    try {
      await Promise.race([
        received,
        new Promise<never>((_, reject) => child.once("exit", (code) => reject(new Error(`worker exited before claiming: ${code}`))),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("worker did not claim")), 5000)),
      ]);
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => board.close(() => resolve()));
    }
  });
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
