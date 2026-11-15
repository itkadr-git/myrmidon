// server/src/myrmidon/litellm-sync/litellm-sync-startup-dryrun.myrmidon.test.ts
//
// myrmidon(OPE-13188): startup applies scoped card-key reconciliation, not the
// full registry to every restricted key. The other startup tests inject ports;
// this one exercises the real default allowlist port with a mocked pass.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";

const handler = vi.hoisted(() => ({
  updateAgentAllowlistsForCompany: vi.fn(async (..._args: unknown[]) => ({
    attempted: 3,
    updated: 3,
    skipped: [] as string[],
  })),
}));

vi.mock("./agent-allowlist-handler.js", () => handler);
vi.mock("../litellm-keys/agent-keys.js", () => ({ defaultAgentGatewayKeyDeps: () => ({ marker: "deps" }) }));
vi.mock("../../services/index.js", () => ({ secretService: () => ({}) }));
vi.mock("../../middleware/logger.js", () => ({ logger: { info: () => undefined, warn: () => undefined } }));

import { startLitellmModelReconciliation, startAgentAllowlistWatchdog } from "./startup-reconciler.js";

const ENV = {
  MYRMIDON_LITELLM_BASE_URL: "http://gateway.internal:4000",
  MYRMIDON_LITELLM_ADMIN_KEY_SECRET: "gateway-admin",
} as NodeJS.ProcessEnv;

function emptyDb(): Db {
  const chain: Record<string, unknown> = {};
  for (const step of ["from", "where", "innerJoin", "limit"]) chain[step] = () => chain;
  chain.then = (resolve: (value: unknown[]) => unknown) => Promise.resolve([]).then(resolve);
  return { select: () => chain } as unknown as Db;
}

describe("the periodic allowlist watchdog", () => {
  it("repairs drift on each tick and stops cleanly", async () => {
    vi.useFakeTimers();
    const reconcile = vi.fn(async () => {});
    const stop = startAgentAllowlistWatchdog(reconcile, 1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(reconcile).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(reconcile).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe("the default startup allowlist port", () => {
  beforeEach(() => {
    handler.updateAgentAllowlistsForCompany.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "Content-Type": "application/json" } })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("applies scoped card allowlists at boot rather than widening keys to the registry", async () => {
    const lines: Array<{ fields: object; message: string }> = [];
    await startLitellmModelReconciliation(emptyDb(), {
      env: ENV,
      ports: {
        listCompanyIds: async () => ["company-a"],
        readAdminKey: async () => "admin-value",
        log: {
          info: (fields: object, message: string) => lines.push({ fields, message }),
          warn: (fields: object, message: string) => lines.push({ fields, message }),
        },
      },
    });

    expect(handler.updateAgentAllowlistsForCompany).toHaveBeenCalledTimes(1);
    const args = handler.updateAgentAllowlistsForCompany.mock.calls[0]!;
    expect(args[2]).toBe("company-a");
    expect(args[5]).toEqual({ apply: true, cardModelsOnly: true });
    expect(lines.some((l) => l.message.includes("nothing applied"))).toBe(false);
  });
});
