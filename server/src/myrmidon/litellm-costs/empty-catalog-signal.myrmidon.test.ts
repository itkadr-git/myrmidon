import { beforeEach, describe, expect, it } from "vitest";

import {
  emptyCatalogDedupKey,
  EMPTY_CATALOG_ATTENTION_DEDUP_PREFIX,
  EMPTY_CATALOG_ATTENTION_TITLE,
  litellmBudgetSignalsForKey,
  readEmptyCatalogSignal,
  readLitellmBudgetSignals,
  recordLitellmBudgetSignals,
  recordEmptyCatalogSweep,
  resetEmptyCatalogSignals,
} from "./attention.js";
import {
  sweepLitellmCosts,
  type LitellmCostsDeps,
  type LitellmGatewayClient,
} from "./litellm-costs.js";

// Neutral ids only: company-a, example.com, no real keys or hosts.

const COMPANY = "company-a";
const NOW = new Date("2026-10-08T12:00:00.000Z");

const SETTINGS = {
  enabled: true,
  baseUrl: "http://example.com:4000",
  keySecret: "gw-key",
  intervalMs: 300_000,
  firstLookbackDays: 1,
};

function gatewayClient(models: Array<{ modelName: string }>): LitellmGatewayClient {
  return {
    async listSpendLogs() {
      return [];
    },
    async listModels() {
      return models.map((m) => ({
        modelName: m.modelName,
        provider: null,
        maxInputTokens: null,
        maxOutputTokens: null,
        rates: {},
      }));
    },
    async listAvailableModels() {
      return [];
    },
  };
}

// A minimal drizzle-shaped stub: the sweep touches three queries before and
// around the catalog refresh — the lookback select, the run-window select and
// the model upsert (only when the catalog is non-empty). Every chain resolves
// to an empty result; nothing is asserted about the writes themselves.
function sweepDbStub() {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  for (const method of ["from", "where", "orderBy", "limit", "values", "onConflictDoNothing"]) {
    chain[method] = () => self();
  }
  chain.returning = () => Promise.resolve([]);
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve);
  return {
    select: () => self(),
    insert: () => self(),
  } as unknown as LitellmCostsDeps["db"];
}

function sweepDeps(models: Array<{ modelName: string }>): LitellmCostsDeps {
  return {
    db: sweepDbStub(),
    async readGatewayKey() {
      return "sk-test";
    },
    async listBotKeys() {
      return [];
    },
    client: () => gatewayClient(models),
    now: () => NOW,
    log: { info: () => {}, warn: () => {} },
  };
}

beforeEach(() => {
  resetEmptyCatalogSignals();
});

describe("myrmidon(1.6.5-F-18) empty catalog attention signal", () => {
  it("records one signal when the sweep refresh returns 0 models", async () => {
    await sweepLitellmCosts(sweepDeps([]), COMPANY, SETTINGS);
    const signal = readEmptyCatalogSignal(COMPANY);
    expect(signal).not.toBeNull();
    expect(signal?.dedupKey).toBe(`${EMPTY_CATALOG_ATTENTION_DEDUP_PREFIX}${COMPANY}`);
    expect(signal?.title).toBe(EMPTY_CATALOG_ATTENTION_TITLE);
    expect(signal?.severity).toBe("high");
    expect(signal?.whyNow).toContain("MYRMIDON_LITELLM_KEY_SECRET");
    expect(signal?.activityAt).toBe(NOW.toISOString());
  });

  it("records no signal when the catalog is non-empty", async () => {
    await sweepLitellmCosts(sweepDeps([{ modelName: "openai/example-model" }]), COMPANY, SETTINGS);
    expect(readEmptyCatalogSignal(COMPANY)).toBeNull();
  });

  it("keeps one card on repeated empty sweeps (dedup)", async () => {
    const deps = sweepDeps([]);
    await sweepLitellmCosts(deps, COMPANY, SETTINGS);
    const first = readEmptyCatalogSignal(COMPANY);
    await sweepLitellmCosts(deps, COMPANY, SETTINGS);
    const second = readEmptyCatalogSignal(COMPANY);
    expect(second?.dedupKey).toBe(first?.dedupKey);
    expect(second?.activityAt).toBe(first?.activityAt);
  });

  it("clears the signal when the catalog recovers", async () => {
    await sweepLitellmCosts(sweepDeps([]), COMPANY, SETTINGS);
    expect(readEmptyCatalogSignal(COMPANY)).not.toBeNull();
    await sweepLitellmCosts(sweepDeps([{ modelName: "openai/example-model" }]), COMPANY, SETTINGS);
    expect(readEmptyCatalogSignal(COMPANY)).toBeNull();
  });

  it("does not record a signal when the model refresh itself fails", async () => {
    const deps: LitellmCostsDeps = {
      ...sweepDeps([]),
      client: () => ({
        ...gatewayClient([]),
        async listModels() {
          throw new Error("gateway unreachable");
        },
      }),
    };
    await sweepLitellmCosts(deps, COMPANY, SETTINGS);
    expect(readEmptyCatalogSignal(COMPANY)).toBeNull();
  });

  it("ignores an unknown (null) catalog size and keeps the previous state", () => {
    recordEmptyCatalogSweep(COMPANY, 0, NOW.toISOString());
    expect(readEmptyCatalogSignal(COMPANY)).not.toBeNull();
    recordEmptyCatalogSweep(COMPANY, null, NOW.toISOString());
    expect(readEmptyCatalogSignal(COMPANY)).not.toBeNull();
    recordEmptyCatalogSweep(COMPANY, 3, NOW.toISOString());
    expect(readEmptyCatalogSignal(COMPANY)).toBeNull();
  });

  it("builds a stable dedup key from the company id", () => {
    expect(emptyCatalogDedupKey(COMPANY)).toBe(`${EMPTY_CATALOG_ATTENTION_DEDUP_PREFIX}${COMPANY}`);
    expect(emptyCatalogDedupKey("other-company")).not.toBe(emptyCatalogDedupKey(COMPANY));
  });
});

describe("LiteLLM key budget attention classification", () => {
  const input = {
    companyId: COMPANY,
    agentId: "agent-a",
    agentName: "Builder",
    capCents: 1_000,
    gatewaySpendCents: 800,
    dailySpendCents: 100,
    weeklySpendCents: 700,
    activityAt: NOW.toISOString(),
  };

  it("emits a near-cap signal at exactly 80%", () => {
    expect(litellmBudgetSignalsForKey(input).map((signal) => signal.kind)).toEqual(["near_cap"]);
  });

  it("emits exhausted instead of near-cap at 100%", () => {
    const signals = litellmBudgetSignalsForKey({ ...input, gatewaySpendCents: 1_000 });
    expect(signals.find((signal) => signal.kind === "exhausted")?.severity).toBe("critical");
    expect(signals.some((signal) => signal.kind === "near_cap")).toBe(false);
  });

  it("emits a daily anomaly at twice the seven-day daily average", () => {
    const signals = litellmBudgetSignalsForKey({ ...input, dailySpendCents: 200 });
    expect(signals.map((signal) => signal.kind)).toEqual(["near_cap", "daily_anomaly"]);
  });

  it("does not call a brand-new key an anomaly: no earlier spend, no baseline", () => {
    // All of the week's spend is inside the last 24 h.
    const signals = litellmBudgetSignalsForKey({
      ...input, capCents: null, gatewaySpendCents: null, dailySpendCents: 500, weeklySpendCents: 500,
    });
    expect(signals).toEqual([]);
  });

  it("ignores a jump below the daily floor", () => {
    // 60 cents is 3x the 20 cents baseline, but under a dollar a day is noise.
    const signals = litellmBudgetSignalsForKey({
      ...input, capCents: null, gatewaySpendCents: null, dailySpendCents: 60, weeklySpendCents: 180,
    });
    expect(signals).toEqual([]);
  });

  it("compares the last 24 h with the average of the six days before them", () => {
    // Baseline (700 - 200) / 6 = 83 cents a day; 200 is 2.4x.
    const [signal] = litellmBudgetSignalsForKey({
      ...input, capCents: null, gatewaySpendCents: null, dailySpendCents: 200, weeklySpendCents: 700,
    });
    expect(signal?.kind).toBe("daily_anomaly");
    expect(signal?.whyNow).toContain("200 cents");
    expect(signal?.whyNow).toContain("83 cents per day");
  });

  it("does not emit cap or anomaly signals without usable observations", () => {
    expect(litellmBudgetSignalsForKey({
      ...input,
      capCents: null,
      gatewaySpendCents: null,
      weeklySpendCents: 0,
    })).toEqual([]);
  });
});

describe("LiteLLM key budget signal registry", () => {
  const signalFor = (activityAt: string) => litellmBudgetSignalsForKey({
    companyId: COMPANY,
    agentId: "agent-a",
    capCents: 1_000,
    gatewaySpendCents: 900,
    dailySpendCents: 0,
    weeklySpendCents: 0,
    activityAt,
  });

  it("keeps the first activityAt of a card that is still raised", () => {
    resetEmptyCatalogSignals();
    recordLitellmBudgetSignals(COMPANY, signalFor("2026-10-08T12:00:00.000Z"));
    recordLitellmBudgetSignals(COMPANY, signalFor("2026-10-08T12:15:00.000Z"));
    const [signal] = readLitellmBudgetSignals(COMPANY);
    expect(readLitellmBudgetSignals(COMPANY)).toHaveLength(1);
    expect(signal?.activityAt).toBe("2026-10-08T12:00:00.000Z");
  });

  it("drops the card once the key is back under the threshold and clears on reset", () => {
    resetEmptyCatalogSignals();
    recordLitellmBudgetSignals(COMPANY, signalFor("2026-10-08T12:00:00.000Z"));
    recordLitellmBudgetSignals(COMPANY, []);
    expect(readLitellmBudgetSignals(COMPANY)).toEqual([]);
    recordLitellmBudgetSignals(COMPANY, signalFor("2026-10-08T12:30:00.000Z"));
    resetEmptyCatalogSignals();
    expect(readLitellmBudgetSignals(COMPANY)).toEqual([]);
  });

  it("scopes the card id to the company and the agent", () => {
    const [signal] = signalFor("2026-10-08T12:00:00.000Z");
    expect(signal?.dedupKey).toBe(`litellm_budget:near_cap:${COMPANY}:agent-a`);
  });
});
