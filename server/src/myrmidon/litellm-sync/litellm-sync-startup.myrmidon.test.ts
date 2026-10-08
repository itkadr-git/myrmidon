// server/src/myrmidon/litellm-sync/litellm-sync-startup.myrmidon.test.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS B): tests for the startup reconciliation.
//
// Covers the blockers the review returned:
// - unset gateway pair — skip with a log, no fetch at all (never dials
//   localhost with an empty key);
// - the admin-key env carries the secret NAME: the client authenticates with
//   the resolved VALUE from the store, never the name;
// - a company without a value under that name is skipped;
// - the allowlist pass runs after a company's reconciliation.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { startLitellmModelReconciliation, type LitellmReconcilePorts } from "./startup-reconciler.js";

const ENABLED_ENV = {
  MYRMIDON_LITELLM_BASE_URL: "http://gateway.internal:4000",
  MYRMIDON_LITELLM_ADMIN_KEY_SECRET: "gateway-admin",
} as NodeJS.ProcessEnv;

/** A db whose select chains resolve to no rows (models, credentials, companies). */
function emptyDb(): Db {
  const chain: Record<string, unknown> = {};
  for (const step of ["from", "where", "innerJoin", "limit"]) {
    chain[step] = () => chain;
  }
  chain.then = (resolve: (value: unknown[]) => unknown) => Promise.resolve([]).then(resolve);
  return { select: () => chain } as unknown as Db;
}

function recordingLog() {
  const lines: Array<{ level: string; fields: object; message: string }> = [];
  return {
    lines,
    info: (fields: object, message: string) => lines.push({ level: "info", fields, message }),
    warn: (fields: object, message: string) => lines.push({ level: "warn", fields, message }),
  };
}

interface FetchCall {
  url: string;
  method?: string;
  auth: string | null;
}

function portsWith(overrides: Partial<LitellmReconcilePorts>): LitellmReconcilePorts {
  return {
    listCompanyIds: async () => ["company-a"],
    readAdminKey: async () => "admin-value",
    refreshAgentAllowlists: vi.fn(async () => ({ attempted: 0, updated: 0, skipped: [] })),
    log: recordingLog(),
    ...overrides,
  };
}

describe("startLitellmModelReconciliation", () => {
  let fetchCalls: FetchCall[];

  beforeEach(() => {
    fetchCalls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        fetchCalls.push({
          url: String(input),
          method: init?.method,
          auth: headers.get("Authorization"),
        });
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips silently when the gateway pair is unset (no fetch)", async () => {
    const log = recordingLog();
    const refresh = vi.fn();
    await startLitellmModelReconciliation(emptyDb(), {
      env: {} as NodeJS.ProcessEnv,
      ports: portsWith({ log, refreshAgentAllowlists: refresh }),
    });
    expect(fetchCalls).toHaveLength(0);
    expect(refresh).not.toHaveBeenCalled();
    expect(log.lines.some((l) => l.message.includes("MYRMIDON_LITELLM_BASE_URL"))).toBe(true);
  });

  it("skips when only the base URL is set (no localhost default, no fetch)", async () => {
    const log = recordingLog();
    await startLitellmModelReconciliation(emptyDb(), {
      env: { MYRMIDON_LITELLM_BASE_URL: "http://gateway.internal:4000" } as NodeJS.ProcessEnv,
      ports: portsWith({ log }),
    });
    expect(fetchCalls).toHaveLength(0);
    expect(log.lines.some((l) => l.message.includes("is not set"))).toBe(true);
  });

  it("authenticates with the resolved secret VALUE, never the NAME from the env", async () => {
    const log = recordingLog();
    await startLitellmModelReconciliation(emptyDb(), {
      env: ENABLED_ENV,
      ports: portsWith({
        log,
        readAdminKey: async (_db, _companyId, secretName) => {
          // The port is asked for the NAME the env carries and answers a value.
          expect(secretName).toBe("gateway-admin");
          return "admin-value";
        },
      }),
    });
    expect(fetchCalls.length).toBeGreaterThan(0);
    for (const call of fetchCalls) {
      expect(call.auth).toBe("Bearer admin-value");
      expect(call.auth).not.toContain("gateway-admin");
      expect(call.url.startsWith("http://gateway.internal:4000")).toBe(true);
    }
  });

  it("skips a company whose admin-key secret has no value and does not fetch", async () => {
    const log = recordingLog();
    const refresh = vi.fn();
    await startLitellmModelReconciliation(emptyDb(), {
      env: ENABLED_ENV,
      ports: portsWith({
        log,
        readAdminKey: async () => null,
        refreshAgentAllowlists: refresh,
      }),
    });
    expect(fetchCalls).toHaveLength(0);
    expect(refresh).not.toHaveBeenCalled();
    expect(
      log.lines.some((l) => l.message.includes("admin key secret has no value in the store")),
    ).toBe(true);
  });

  it("re-applies the agent allowlists after a company reconciles", async () => {
    const refresh = vi.fn(async () => ({ attempted: 2, updated: 2, skipped: [] }));
    await startLitellmModelReconciliation(emptyDb(), {
      env: ENABLED_ENV,
      ports: portsWith({ refreshAgentAllowlists: refresh }),
    });
    expect(refresh).toHaveBeenCalledWith(expect.anything(), "company-a", ENABLED_ENV);
  });

  it("one company's failure never stops the others or the caller", async () => {
    const log = recordingLog();
    const ids = ["company-a", "company-b"];
    let seen = 0;
    await startLitellmModelReconciliation(emptyDb(), {
      env: ENABLED_ENV,
      ports: portsWith({
        log,
        listCompanyIds: async () => ids,
        readAdminKey: async () => {
          seen += 1;
          if (seen === 1) throw new Error("gateway unreachable");
          return "admin-value";
        },
      }),
    });
    expect(seen).toBe(2);
    expect(log.lines.some((l) => l.level === "warn" && l.message.includes("one company"))).toBe(true);
  });
});
