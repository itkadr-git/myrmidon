// server/src/myrmidon/litellm-sync/litellm-sync-startup-dryrun.myrmidon.test.ts
//
// myrmidon(1.6.7 OPE-12345): the DEFAULT startup port runs the agent key
// allowlist pass as a dry run. Applying it adds every enabled registry model to
// every restricted key (76 keys on the production board), so a boot must only
// count and log the differences. The other startup tests inject their own
// port; this one lets the real default port run against a mocked pass.

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

  it("calls the pass with apply: false, so no key is rewritten at boot", async () => {
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
    expect(args[6]).toEqual({ apply: false });
    expect(lines.some((l) => l.message.includes("nothing applied"))).toBe(true);
    expect(lines.find((l) => l.message.includes("nothing applied"))?.fields).toMatchObject({
      mode: "dry-run",
      keysToChange: 3,
    });
  });
});
