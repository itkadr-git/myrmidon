// myrmidon(OPE-11776): the cap and spend of the bot keys, in the board.
// Neutral ids only: company-a, example hosts, made-up key values.

import { beforeEach, describe, expect, it } from "vitest";
import {
  readLitellmBudgetSignals,
  readLitellmKeyBudgetGauges,
  resetEmptyCatalogSignals,
} from "./attention.js";
import {
  evaluateKeyBudgets,
  keyCapStatus,
  readKeyUsageReport,
  resetKeyUsageReports,
  type KeyBudgetDeps,
} from "./key-budgets.js";
import {
  gatewayKeyHash,
  parseKeyListPage,
  type GatewayKeyBudgetRow,
  type LitellmCostSettings,
  type LitellmGatewayClient,
} from "./litellm-costs.js";

const COMPANY = "company-a";
const NOW = new Date("2026-11-05T12:00:00.000Z");
const KEY_A = "test-key-agent-a";
const KEY_B = "test-key-agent-b";
const KEY_C = "test-key-agent-c";

const SETTINGS: LitellmCostSettings = {
  enabled: true,
  baseUrl: "http://gateway.internal:4000",
  keySecret: "accounting-secret",
  intervalMs: 300_000,
  firstLookbackDays: 1,
};

const db = {
  select: () => ({
    from: () => ({
      where: async () => [
        { id: "agent-a", name: "alpha" },
        { id: "agent-b", name: "beta" },
        { id: "agent-c", name: "gamma" },
      ],
    }),
  }),
} as never;

function gatewayRows(): GatewayKeyBudgetRow[] {
  return [
    { tokenHash: gatewayKeyHash(KEY_A), maxBudgetUsd: 10, spendUsd: 8.5 },
    { tokenHash: gatewayKeyHash(KEY_B), maxBudgetUsd: 5, spendUsd: 5.2 },
    // agent-c's key is not on the list: unknown cap, not "no cap".
  ];
}

function clientOf(rows: GatewayKeyBudgetRow[] | Error): LitellmGatewayClient {
  return {
    listSpendLogs: async () => [],
    listModels: async () => [],
    listKeyBudgets: async () => {
      if (rows instanceof Error) throw rows;
      return rows;
    },
  };
}

function makeDeps(overrides: Partial<KeyBudgetDeps> = {}) {
  const calls = { botKeys: 0, secrets: [] as Array<[string, string]> };
  const deps: KeyBudgetDeps = {
    db,
    settings: SETTINGS,
    readGatewayKey: async (companyId, secretName) => {
      calls.secrets.push([companyId, secretName]);
      return "accounting-key";
    },
    listBotKeys: async () => {
      calls.botKeys += 1;
      return [
        { agentId: "agent-a", keyValue: KEY_A },
        { agentId: "agent-b", keyValue: KEY_B },
        { agentId: "agent-c", keyValue: KEY_C },
        // The same agent twice (a card re-resolved): one row.
        { agentId: "agent-a", keyValue: KEY_A },
      ];
    },
    client: () => clientOf(gatewayRows()),
    readSpendWindows: async () => [
      { companyId: COMPANY, agentId: "agent-a", dailyCents: 300, weeklyCents: 600, zeroCostEvents: 2 },
      { companyId: COMPANY, agentId: "agent-b", dailyCents: 50, weeklyCents: 350, zeroCostEvents: 0 },
      // Another company's ledger row must not leak in.
      { companyId: "company-b", agentId: "agent-c", dailyCents: 999_999, weeklyCents: 999_999, zeroCostEvents: 9 },
    ],
    now: () => NOW,
    ...overrides,
  };
  return { deps, calls };
}

describe("myrmidon(OPE-11776) key budgets", () => {
  beforeEach(() => {
    resetEmptyCatalogSignals();
    resetKeyUsageReports();
  });

  it("matches the bot keys to the gateway's key list by hash and classifies each cap", async () => {
    const { deps, calls } = makeDeps();
    const report = await evaluateKeyBudgets(deps, COMPANY);

    expect(calls.secrets).toEqual([[COMPANY, "accounting-secret"]]);
    expect(report.gatewayAvailable).toBe(true);
    expect(report.ledgerAvailable).toBe(true);
    expect(report.rows.map((row) => row.agentId)).toEqual(["agent-a", "agent-b", "agent-c"]);
    const [a, b, c] = report.rows;
    expect(a).toMatchObject({
      agentName: "alpha", capUsd: 10, gatewaySpendUsd: 8.5, status: "near_cap",
      dailyCents: 300, weeklyCents: 600, zeroCostEvents: 2,
    });
    expect(a?.utilizationPercent).toBeCloseTo(85);
    expect(b).toMatchObject({ capUsd: 5, gatewaySpendUsd: 5.2, status: "exhausted", dailyCents: 50, weeklyCents: 350 });
    expect(c).toMatchObject({ capUsd: null, gatewaySpendUsd: null, utilizationPercent: null, status: "unknown" });
    // Only agent-c's own company row counts: company-b's 999999 is not agent-c's here.
    expect(c).toMatchObject({ dailyCents: 0, weeklyCents: 0, zeroCostEvents: 0 });
  });

  it("raises the cap and anomaly signals and the utilization gauges for the attention feed and the scrape", async () => {
    const { deps } = makeDeps();
    await evaluateKeyBudgets(deps, COMPANY);

    const signals = readLitellmBudgetSignals(COMPANY);
    expect(signals.map((signal) => `${signal.agentId}:${signal.kind}`).sort()).toEqual([
      "agent-a:daily_anomaly",
      "agent-a:near_cap",
      "agent-b:exhausted",
    ]);
    expect(signals.find((signal) => signal.kind === "exhausted")?.severity).toBe("critical");
    expect(readLitellmKeyBudgetGauges().map((gauge) => gauge.agentId).sort()).toEqual(["agent-a", "agent-b"]);
    expect(readLitellmBudgetSignals("company-b")).toEqual([]);
  });

  it("carries no key value and no key hash in the report", async () => {
    const { deps } = makeDeps();
    const text = JSON.stringify(await evaluateKeyBudgets(deps, COMPANY));
    for (const secret of [KEY_A, KEY_B, KEY_C, "accounting-key", gatewayKeyHash(KEY_A), gatewayKeyHash(KEY_B)]) {
      expect(text).not.toContain(secret);
    }
  });

  it("keeps the signals it had, and reports no caps, when the gateway cannot be read", async () => {
    await evaluateKeyBudgets(makeDeps().deps, COMPANY);
    const before = readLitellmBudgetSignals(COMPANY).length;
    expect(before).toBeGreaterThan(0);

    const report = await evaluateKeyBudgets(
      makeDeps({ client: () => clientOf(new Error("LLM gateway /key/list answered 500")) }).deps,
      COMPANY,
    );
    expect(report.gatewayAvailable).toBe(false);
    expect(report.rows.every((row) => row.capUsd === null && row.status === "unknown")).toBe(true);
    expect(report.rows[0]?.dailyCents).toBe(300);
    expect(readLitellmBudgetSignals(COMPANY)).toHaveLength(before);
  });

  it("drops a card once the key is back under its threshold", async () => {
    await evaluateKeyBudgets(makeDeps().deps, COMPANY);
    expect(readLitellmBudgetSignals(COMPANY).some((signal) => signal.kind === "exhausted")).toBe(true);

    const reset = gatewayRows().map((row) => ({ ...row, spendUsd: 0 }));
    await evaluateKeyBudgets(makeDeps({ client: () => clientOf(reset) }).deps, COMPANY);
    expect(readLitellmBudgetSignals(COMPANY).some((signal) => signal.kind === "exhausted")).toBe(false);
    expect(readLitellmBudgetSignals(COMPANY).some((signal) => signal.kind === "near_cap")).toBe(false);
  });

  it("reports caps without ledger numbers when the ledger cannot be read", async () => {
    const report = await evaluateKeyBudgets(
      makeDeps({
        readSpendWindows: async () => {
          throw new Error("canceling statement due to statement timeout");
        },
      }).deps,
      COMPANY,
    );
    expect(report.ledgerAvailable).toBe(false);
    expect(report.gatewayAvailable).toBe(true);
    expect(report.rows[0]).toMatchObject({ capUsd: 10, status: "near_cap", dailyCents: null, weeklyCents: null, zeroCostEvents: null });
    // Without the ledger there is nothing to call an anomaly.
    expect(readLitellmBudgetSignals(COMPANY).some((signal) => signal.kind === "daily_anomaly")).toBe(false);
  });

  it("has no gateway data when the accounting key secret is missing", async () => {
    const report = await evaluateKeyBudgets(makeDeps({ readGatewayKey: async () => null }).deps, COMPANY);
    expect(report.gatewayAvailable).toBe(false);
    expect(report.rows).toHaveLength(3);
  });

  it("serves the cached report inside the TTL and shares it between readers", async () => {
    const { deps, calls } = makeDeps();
    const [first, second] = await Promise.all([readKeyUsageReport(deps, COMPANY), readKeyUsageReport(deps, COMPANY)]);
    await readKeyUsageReport(deps, COMPANY);
    expect(first).toBe(second);
    expect(calls.botKeys).toBe(1);
    resetKeyUsageReports();
    await readKeyUsageReport(deps, COMPANY);
    expect(calls.botKeys).toBe(2);
  });

  it("does not cache a failed evaluation", async () => {
    let fail = true;
    const { deps } = makeDeps({
      listBotKeys: async () => {
        if (fail) throw new Error("secrets unavailable");
        return [{ agentId: "agent-a", keyValue: KEY_A }];
      },
    });
    await expect(readKeyUsageReport(deps, COMPANY)).rejects.toThrow("secrets unavailable");
    fail = false;
    await expect(readKeyUsageReport(deps, COMPANY)).resolves.toMatchObject({ rows: [{ agentId: "agent-a" }] });
  });

  it("classifies the cap use at 80% and 100%", () => {
    expect(keyCapStatus(null)).toBe("unknown");
    expect(keyCapStatus(79.9)).toBe("ok");
    expect(keyCapStatus(80)).toBe("near_cap");
    expect(keyCapStatus(99.99)).toBe("near_cap");
    expect(keyCapStatus(100)).toBe("exhausted");
    expect(keyCapStatus(130)).toBe("exhausted");
  });
});

describe("myrmidon(OPE-11776) gateway key list page", () => {
  it("reads the hash, cap and spend and nothing else of a key object", () => {
    const parsed = parseKeyListPage({
      keys: [
        { token: "hash-1", key_alias: "alpha", max_budget: 12.5, spend: 3.25, key_name: "sk-...abcd", metadata: { x: 1 } },
        { token: "hash-2", max_budget: 0, spend: -1 },
        { token: "hash-3", max_budget: null, spend: 0 },
        { key_alias: "no-token" },
        "bare-hash-string",
      ],
      total_count: 3,
      current_page: 2,
      total_pages: 4,
    });
    expect(parsed).toEqual({
      rows: [
        { tokenHash: "hash-1", maxBudgetUsd: 12.5, spendUsd: 3.25 },
        { tokenHash: "hash-2", maxBudgetUsd: null, spendUsd: null },
        { tokenHash: "hash-3", maxBudgetUsd: null, spendUsd: 0 },
      ],
      totalPages: 4,
    });
  });

  it("treats a missing page count as one page and refuses any other shape", () => {
    expect(parseKeyListPage({ keys: [] })).toEqual({ rows: [], totalPages: 1 });
    expect(parseKeyListPage({ keys: [], total_pages: 0 })).toEqual({ rows: [], totalPages: 1 });
    expect(parseKeyListPage({ detail: "Not Found" })).toBeNull();
    expect(parseKeyListPage(null)).toBeNull();
    expect(parseKeyListPage([])).toBeNull();
  });
});
