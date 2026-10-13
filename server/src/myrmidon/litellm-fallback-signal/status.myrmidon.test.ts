import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveFallbackSignalSettings } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import {
  readModelFallbackSignals,
  resetModelFallbackSignals,
  type FallbackShare,
} from "./attention.js";
import {
  buildFallbackStatusRows,
  clearFallbackStatus,
  fallbackStatusView,
  readFallbackStatus,
  recordFallbackStatus,
  resetFallbackStatus,
} from "./status.js";
import { startModelFallbackSignalSweep, type FallbackSweepDeps } from "./sweep.js";
import { gatewayKeyHash, type SpendLogEntry } from "../litellm-costs/litellm-costs.js";

// Neutral ids only: agent-a, company-a, no real keys or hosts.

const KEY_A = "sk-test-fallback-signal-agent-a";
const AGENT_A = "agent-a";
const COMPANY = "company-a";

const CARD_A = { model: "model-primary", models: { fallbacks: ["model-fb-1"] } };

function entry(overrides: Partial<SpendLogEntry> = {}): SpendLogEntry {
  return {
    requestId: "req-1",
    apiKey: gatewayKeyHash(KEY_A),
    spend: 0.01,
    promptTokens: 100,
    completionTokens: 50,
    startTime: "2026-10-03T10:05:00.000Z",
    model: "model-primary",
    provider: "openai",
    ...overrides,
  };
}

function share(overrides: Partial<FallbackShare> = {}): FallbackShare {
  return {
    agentId: AGENT_A,
    total: 20,
    fallbacks: 6,
    sharePct: 30,
    servedModels: ["model-swapped"],
    ...overrides,
  };
}

/** Ten attributed calls of which three are out of card: 30%. */
function tenCallsWithThirtyPercent(): SpendLogEntry[] {
  return [
    ...Array.from({ length: 7 }, (_, i) => entry({ requestId: `req-k-${i}`, model: "model-primary" })),
    ...Array.from({ length: 3 }, (_, i) => entry({ requestId: `req-o-${i}`, model: "model-swapped" })),
  ];
}

const SETTINGS = {
  enabled: true,
  windowMs: 3_600_000,
  thresholdPct: 20,
  minCalls: 5,
  intervalMs: 300_000,
};

function deps(entries: SpendLogEntry[]): FallbackSweepDeps {
  return {
    async listSpendLogs() {
      return entries;
    },
    async listBotKeys() {
      return [{ agentId: AGENT_A, keyValue: KEY_A }];
    },
    async readGatewayKey() {
      return null; // never read in tests: the client is mocked
    },
    async listAgentCards(companyId: string) {
      if (companyId !== COMPANY) return [];
      return [{ agentId: AGENT_A, adapterConfig: CARD_A }];
    },
    async listCompanyIds() {
      return [COMPANY];
    },
    now: () => new Date("2026-10-03T11:00:00.000Z"),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

beforeEach(() => {
  resetModelFallbackSignals();
  resetFallbackStatus();
});

afterEach(() => {
  resetModelFallbackSignals();
  resetFallbackStatus();
  vi.useRealTimers();
});

describe("myrmidon(BOT-RUNTIME-TUNING D2) per-agent rows", () => {
  it("marks the agents at or above the threshold and leaves the others quiet", () => {
    const rows = buildFallbackStatusRows(
      [share({ agentId: "agent-a", sharePct: 30, total: 20 }), share({ agentId: "agent-b", sharePct: 5, total: 20 })],
      SETTINGS,
    );
    expect(rows.map((row) => [row.agentId, row.aboveThreshold])).toEqual([
      ["agent-a", true],
      ["agent-b", false],
    ]);
  });

  it("does not mark an agent below min calls even at 100%", () => {
    const rows = buildFallbackStatusRows([share({ sharePct: 100, total: 3, fallbacks: 3 })], SETTINGS);
    expect(rows[0].aboveThreshold).toBe(false);
  });

  it("records one snapshot per company and replaces it on the next pass", () => {
    recordFallbackStatus(COMPANY, {
      at: "2026-10-03T11:00:00.000Z",
      thresholdPct: 20,
      minCalls: 5,
      windowSec: 3600,
      rows: [],
    });
    expect(readFallbackStatus(COMPANY)?.at).toBe("2026-10-03T11:00:00.000Z");

    recordFallbackStatus(COMPANY, {
      at: "2026-10-03T11:05:00.000Z",
      thresholdPct: 20,
      minCalls: 5,
      windowSec: 3600,
      rows: buildFallbackStatusRows([share()], SETTINGS),
    });
    expect(readFallbackStatus(COMPANY)?.rows).toHaveLength(1);

    clearFallbackStatus(COMPANY);
    expect(readFallbackStatus(COMPANY)).toBeNull();
    expect(readFallbackStatus("company-b")).toBeNull();
  });
});

describe("myrmidon(BOT-RUNTIME-TUNING D2) status view", () => {
  it("reports the effective numbers and says the company was never swept", () => {
    const resolved = resolveFallbackSignalSettings({
      stored: { enabled: true, thresholdPct: 25, minCalls: 5, windowSec: 900, intervalSec: 60 },
      env: {},
    });
    const view = fallbackStatusView(COMPANY, resolved);
    expect(view).toMatchObject({
      companyId: COMPANY,
      enabled: true,
      thresholdPct: 25,
      minCalls: 5,
      windowSec: 900,
      intervalSec: 60,
      evaluatedAt: null,
      rows: [],
    });
    expect(view.sources.thresholdPct).toBe("settings");
  });

  it("shows the last sweep's rows once they exist", () => {
    recordFallbackStatus(COMPANY, {
      at: "2026-10-03T11:00:00.000Z",
      thresholdPct: 20,
      minCalls: 5,
      windowSec: 3600,
      rows: buildFallbackStatusRows([share()], SETTINGS),
    });
    const view = fallbackStatusView(COMPANY, resolveFallbackSignalSettings({ env: {} }));
    expect(view.evaluatedAt).toBe("2026-10-03T11:00:00.000Z");
    expect(view.rows[0]).toMatchObject({ agentId: AGENT_A, sharePct: 30, aboveThreshold: true });
  });
});

describe("myrmidon(BOT-RUNTIME-TUNING D2) settings are read live", () => {
  it("obeys a threshold changed between two ticks, without a restart", async () => {
    vi.useFakeTimers();
    let thresholdPct = 35;
    const readSettings = async () =>
      resolveFallbackSignalSettings({
        stored: { enabled: true, thresholdPct, minCalls: 5, windowSec: 3600, intervalSec: 60 },
        env: {},
      });

    const stop = startModelFallbackSignalSweep({} as unknown as Db, {
      env: {},
      deps: deps(tenCallsWithThirtyPercent()),
      readSettings,
    });

    await vi.advanceTimersByTimeAsync(0);
    // 30% of the calls are fallbacks: under the stored 35% the bot is quiet...
    expect(readFallbackStatus(COMPANY)?.thresholdPct).toBe(35);
    expect(readFallbackStatus(COMPANY)?.rows[0]).toMatchObject({ sharePct: 30, aboveThreshold: false });
    expect(readModelFallbackSignals(COMPANY)).toHaveLength(0);

    // ...and the very next tick, after the stored threshold drops to 10%, the
    // same calls raise the signal. No restart in between.
    thresholdPct = 10;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readFallbackStatus(COMPANY)?.thresholdPct).toBe(10);
    expect(readFallbackStatus(COMPANY)?.rows[0]?.aboveThreshold).toBe(true);
    expect(readModelFallbackSignals(COMPANY)).toHaveLength(1);

    stop();
  });

  it("clears the signal and the rows when the switch is turned off at runtime", async () => {
    vi.useFakeTimers();
    let enabled = true;
    const readSettings = async () =>
      resolveFallbackSignalSettings({
        stored: { enabled, thresholdPct: 10, minCalls: 5, windowSec: 3600, intervalSec: 60 },
        env: {},
      });

    const stop = startModelFallbackSignalSweep({} as unknown as Db, {
      env: {},
      deps: deps(tenCallsWithThirtyPercent()),
      readSettings,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(readModelFallbackSignals(COMPANY)).toHaveLength(1);

    enabled = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readModelFallbackSignals(COMPANY)).toHaveLength(0);
    expect(readFallbackStatus(COMPANY)).toBeNull();

    stop();
  });

  it("makes no gateway request while the switch is off", async () => {
    vi.useFakeTimers();
    const listSpendLogs = vi.fn(async () => tenCallsWithThirtyPercent());
    const stop = startModelFallbackSignalSweep({} as unknown as Db, {
      env: {},
      deps: { ...deps([]), listSpendLogs },
      readSettings: async () => resolveFallbackSignalSettings({ stored: { enabled: false }, env: {} }),
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(listSpendLogs).not.toHaveBeenCalled();

    stop();
  });
});