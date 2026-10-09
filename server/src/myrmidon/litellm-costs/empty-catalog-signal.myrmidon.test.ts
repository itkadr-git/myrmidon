import { beforeEach, describe, expect, it } from "vitest";

import {
  emptyCatalogDedupKey,
  EMPTY_CATALOG_ATTENTION_DEDUP_PREFIX,
  EMPTY_CATALOG_ATTENTION_TITLE,
  readEmptyCatalogSignal,
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
