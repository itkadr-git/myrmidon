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
    updated: 0,
    skipped: [] as string[],
    dryRun: { wouldChange: 3, unchanged: 0, added: { "chatgpt-pool/gpt-6.1-sol": 3 }, removed: {}, changes: [] },
  })),
}));

vi.mock("./agent-allowlist-handler.js", () => handler);
vi.mock("../litellm-keys/agent-keys.js", () => ({ defaultAgentGatewayKeyDeps: () => ({ marker: "deps" }) }));
vi.mock("../../services/index.js", () => ({ secretService: () => ({}) }));
vi.mock("../../middleware/logger.js", () => ({ logger: { info: () => undefined, warn: () => undefined } }));

import { startLitellmModelReconciliation } from "./startup-reconciler.js";

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
    expect(args[6]).toEqual({ apply: true, cardModelsOnly: true });
    expect(lines.some((l) => l.message.includes("nothing applied"))).toBe(false);
  });
});
