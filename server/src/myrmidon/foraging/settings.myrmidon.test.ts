// myrmidon(1.6.1-FORAGING-LIMITS-UI): the read/write service of the stored
// settings row — the live resolve (stored row → env per-key override →
// default), the merge on save, and the RUNTIME-LIMITS-shaped service the
// routes mount. No database, no network: the settings port is a stub.
// Neutral data only.
import { describe, expect, it } from "vitest";
import { FORAGING_SETTINGS_KEY } from "@paperclipai/shared";
import {
  FORAGING_SETTINGS_UPDATED_ACTION,
  foragingSettingsService,
  resolveForagingEffectiveSettings,
  type ForagingSettingsPorts,
} from "./settings.js";

// The settings port of the real service is typed against the instance
// settings row; this stub only carries the foraging key, so it is cast
// through the port type the tests exercise.
type StubSettings = ForagingSettingsPorts["settings"];

function stubSettings(initial: Record<string, unknown> = {}) {
  let general = { ...initial };
  const stub = {
    getGeneral: async () => general,
    updateGeneral: async (patch: Record<string, unknown>) => {
      general = { ...general, ...patch };
      return general;
    },
  };
  // `snapshot` is the test's read-back of the stub's stored row; it stays
  // outside the cast because the real port does not have it.
  return { ...stub, snapshot: () => general } as unknown as StubSettings & { snapshot: () => Record<string, unknown> };
}

function ports(overrides: Partial<ForagingSettingsPorts> = {}): ForagingSettingsPorts {
  return {
    settings: stubSettings(),
    env: {},
    ...overrides,
  };
}

const FULL_STORED = {
  enabled: true,
  intervalSec: 3600,
  minHostIntervalSec: 60,
  passBudgetCents: 50,
  dailyBudgetCents: null,
  monthlyBudgetCents: null,
  roleBudgetCents: null,
  agentBudgetCents: null,
  enforcement: "hard",
  autoOffCostPerTaskCents: null,
};

function storedWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...FULL_STORED, ...overrides };
}

describe("myrmidon(1.6.1-FORAGING-LIMITS-UI) foragingSettingsService.read", () => {
  it("resolves the defaults when nothing is stored and no env is set", async () => {
    const service = foragingSettingsService(null as never, ports());
    const resolved = await service.read();
    expect(resolved.settings.enabled).toBe(false);
    expect(resolved.settings.intervalSec).toBe(3600);
    expect(resolved.settings.passBudgetCents).toBe(50);
    expect(resolved.settings.dailyBudgetCents).toBeNull();
    expect(resolved.sources.enabled).toBe("default");
  });

  it("reads the stored row and marks its origin", async () => {
    const service = foragingSettingsService(
      null as never,
      ports({
        settings: stubSettings({
          [FORAGING_SETTINGS_KEY]: storedWith({ enabled: true, dailyBudgetCents: 100 }),
        }),
      }),
    );
    const resolved = await service.read();
    expect(resolved.settings.enabled).toBe(true);
    expect(resolved.settings.dailyBudgetCents).toBe(100);
    expect(resolved.sources.enabled).toBe("settings");
    expect(resolved.sources.dailyBudgetCents).toBe("settings");
  });

  it("an env variable set for the key wins over the stored row", async () => {
    const service = foragingSettingsService(
      null as never,
      ports({
        settings: stubSettings({
          [FORAGING_SETTINGS_KEY]: storedWith({ enabled: true, intervalSec: 7200 }),
        }),
        env: { MYRMIDON_FORAGING_ENABLED: "0" },
      }),
    );
    const resolved = await service.read();
    // The env key wins: "0" forces off even though the row says on.
    expect(resolved.settings.enabled).toBe(false);
    expect(resolved.sources.enabled).toBe("env");
    // Untouched keys still come from the row.
    expect(resolved.settings.intervalSec).toBe(7200);
    expect(resolved.sources.intervalSec).toBe("settings");
  });

  it("a typo in the env switch does not force it on", async () => {
    const service = foragingSettingsService(
      null as never,
      ports({
        settings: stubSettings({ [FORAGING_SETTINGS_KEY]: storedWith({ enabled: false }) }),
        env: { MYRMIDON_FORAGING_ENABLED: "tru" },
      }),
    );
    const resolved = await service.read();
    // The env key wins with a NO: the row stays "false" too, but the source
    // of the value is the environment override.
    expect(resolved.settings.enabled).toBe(false);
    expect(resolved.sources.enabled).toBe("env");
  });
});

describe("myrmidon(1.6.1-FORAGING-LIMITS-UI) foragingSettingsService.update", () => {
  it("saves a patch, keeps the unmentioned keys and audits the change", async () => {
    const settings = stubSettings({ [FORAGING_SETTINGS_KEY]: storedWith({ enabled: true }) });
    const seen: unknown[] = [];
    const service = foragingSettingsService(null as never, {
      settings,
      env: {},
      logActivity: async (input) => {
        seen.push(input);
      },
    });
    const resolved = await service.update(
      { enabled: true, dailyBudgetCents: 100, intervalSec: 1800 },
      { actorType: "agent", actorId: "ag-1" },
    );
    expect(resolved.settings.enabled).toBe(true);
    expect(resolved.settings.dailyBudgetCents).toBe(100);
    expect(resolved.settings.intervalSec).toBe(1800);
    // The stored row carries the merged settings under the foraging key.
    const stored = settings.snapshot()[FORAGING_SETTINGS_KEY] as Record<string, unknown>;
    expect(stored.dailyBudgetCents).toBe(100);
    // One audit row with the instance action.
    expect(seen).toHaveLength(1);
    expect((seen[0] as { action: string }).action).toBe(FORAGING_SETTINGS_UPDATED_ACTION);
  });

  it("saving an explicit null lifts the stored limit back to no limit", async () => {
    const settings = stubSettings({ [FORAGING_SETTINGS_KEY]: storedWith({ dailyBudgetCents: 100 }) });
    const service = foragingSettingsService(null as never, { settings, env: {} });
    const resolved = await service.update(
      { dailyBudgetCents: null },
      { actorType: "agent", actorId: "ag-1" },
    );
    expect(resolved.settings.dailyBudgetCents).toBeNull();
  });
});

describe("myrmidon(1.6.1-FORAGING-LIMITS-UI) resolveForagingEffectiveSettings", () => {
  it("adapts the resolved settings to the sweep shape", async () => {
    const effective = await resolveForagingEffectiveSettings(
      {
        getGeneral: async () =>
          ({ [FORAGING_SETTINGS_KEY]: storedWith({ enabled: true, passBudgetCents: 120 }) }) as never,
      },
      { MYRMIDON_FORAGING_KEY_SECRET: "board-read-token " },
    );
    expect(effective.settings.enabled).toBe(true);
    expect(effective.intervalMs).toBe(3_600_000);
    expect(effective.minHostIntervalMs).toBe(60_000);
    expect(effective.budget).toEqual({ maxCostCents: 120, enabled: true });
    expect(effective.keySecret).toBe("board-read-token");
  });

  it("a null pass budget becomes the disabled per-pass limit", async () => {
    const effective = await resolveForagingEffectiveSettings(
      {
        getGeneral: async () =>
          ({ [FORAGING_SETTINGS_KEY]: storedWith({ passBudgetCents: null }) }) as never,
      },
      {},
    );
    expect(effective.budget).toEqual({ maxCostCents: 0, enabled: false });
  });
});
