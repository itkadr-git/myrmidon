// myrmidon(1.6.1-FORAGING-LIMITS-UI): tests of the shared settings contract —
// the precedence (stored row, per-key env override, default), the value rules
// (a typo cannot enable the sweep, a zero/negative ceiling is "no limit") and
// the merge the settings service stores. No database, no network.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FORAGING_AGENT_BUDGET_CENTS,
  DEFAULT_FORAGING_AUTO_OFF_COST_PER_TASK_CENTS,
  DEFAULT_FORAGING_DAILY_BUDGET_CENTS,
  DEFAULT_FORAGING_ENABLED,
  DEFAULT_FORAGING_INTERVAL_SEC,
  DEFAULT_FORAGING_MIN_HOST_INTERVAL_SEC,
  DEFAULT_FORAGING_MONTHLY_BUDGET_CENTS,
  DEFAULT_FORAGING_PASS_BUDGET_CENTS,
  DEFAULT_FORAGING_ROLE_BUDGET_CENTS,
  FORAGING_SETTINGS_ENV_KEYS,
  FORAGING_ENFORCEMENT_ENV,
  FORAGING_AUTO_OFF_COST_PER_TASK_ENV,
  mergeForagingSettings,
  normalizeForagingSettings,
  parseForagingBudgetCents,
  parseForagingEnabled,
  readForagingSettingsFromEnv,
  resolveForagingSettings,
  type ForagingSettings,
} from "./myrmidon-foraging.js";

const FULL_STORED: ForagingSettings = {
  enabled: true,
  intervalSec: 7200,
  minHostIntervalSec: 30,
  passBudgetCents: 120,
  dailyBudgetCents: 1000,
  monthlyBudgetCents: 10_000,
  roleBudgetCents: 300,
  agentBudgetCents: 100,
  enforcement: "soft",
  autoOffCostPerTaskCents: 500,
};

describe("myrmidon(1.6.1-FORAGING-LIMITS-UI) env reading", () => {
  it("defaults: off sweep, 1h interval, 60s host pause, 50c pass budget, no other ceilings", () => {
    const settings = readForagingSettingsFromEnv({});
    expect(settings).toEqual({
      enabled: DEFAULT_FORAGING_ENABLED,
      intervalSec: DEFAULT_FORAGING_INTERVAL_SEC,
      minHostIntervalSec: DEFAULT_FORAGING_MIN_HOST_INTERVAL_SEC,
      passBudgetCents: DEFAULT_FORAGING_PASS_BUDGET_CENTS,
      dailyBudgetCents: DEFAULT_FORAGING_DAILY_BUDGET_CENTS,
      monthlyBudgetCents: DEFAULT_FORAGING_MONTHLY_BUDGET_CENTS,
      roleBudgetCents: DEFAULT_FORAGING_ROLE_BUDGET_CENTS,
      agentBudgetCents: DEFAULT_FORAGING_AGENT_BUDGET_CENTS,
      enforcement: "hard",
      autoOffCostPerTaskCents: DEFAULT_FORAGING_AUTO_OFF_COST_PER_TASK_CENTS,
    });
  });

  it("only the exact value 1/true/on enables the sweep; a typo does not", () => {
    expect(parseForagingEnabled("1")).toBe(true);
    expect(parseForagingEnabled("true")).toBe(true);
    expect(parseForagingEnabled("on")).toBe(true);
    expect(parseForagingEnabled("0")).toBe(false);
    expect(parseForagingEnabled("off")).toBe(false);
    expect(parseForagingEnabled("yes please")).toBeNull();
    expect(readForagingSettingsFromEnv({ MYRMIDON_FORAGING_ENABLED: "yes please" }).enabled).toBe(
      false,
    );
  });

  it("a zero or negative ceiling is the explicit no-limit; non-numeric is ignored", () => {
    expect(parseForagingBudgetCents("0")).toBeNull();
    expect(parseForagingBudgetCents("-5")).toBeNull();
    expect(parseForagingBudgetCents("40")).toBe(40);
    expect(parseForagingBudgetCents("41.9")).toBe(41);
    expect(parseForagingBudgetCents("abc")).toBeNull();
    expect(parseForagingBudgetCents(undefined)).toBeNull();
  });

  it("reads every ceiling and the enforcement mode from the environment", () => {
    const settings = readForagingSettingsFromEnv({
      MYRMIDON_FORAGING_ENABLED: "1",
      MYRMIDON_FORAGING_INTERVAL_SEC: "1800",
      MYRMIDON_FORAGING_MIN_HOST_INTERVAL_SEC: "15",
      MYRMIDON_FORAGING_BUDGET_CENTS: "200",
      MYRMIDON_FORAGING_DAILY_BUDGET_CENTS: "1500",
      MYRMIDON_FORAGING_MONTHLY_BUDGET_CENTS: "15000",
      MYRMIDON_FORAGING_ROLE_BUDGET_CENTS: "400",
      MYRMIDON_FORAGING_AGENT_BUDGET_CENTS: "200",
      MYRMIDON_FORAGING_ENFORCEMENT: "soft",
      MYRMIDON_FORAGING_AUTO_OFF_COST_PER_TASK_CENTS: "700",
    });
    expect(settings).toMatchObject({
      enabled: true,
      intervalSec: 1800,
      minHostIntervalSec: 15,
      passBudgetCents: 200,
      dailyBudgetCents: 1500,
      monthlyBudgetCents: 15_000,
      roleBudgetCents: 400,
      agentBudgetCents: 200,
      enforcement: "soft",
      autoOffCostPerTaskCents: 700,
    });
  });

  it("out-of-range interval and host pause fall back to the defaults", () => {
    const settings = readForagingSettingsFromEnv({
      MYRMIDON_FORAGING_INTERVAL_SEC: "10",
      MYRMIDON_FORAGING_MIN_HOST_INTERVAL_SEC: "1",
    });
    expect(settings.intervalSec).toBe(DEFAULT_FORAGING_INTERVAL_SEC);
    expect(settings.minHostIntervalSec).toBe(DEFAULT_FORAGING_MIN_HOST_INTERVAL_SEC);
  });
});

describe("myrmidon(1.6.1-FORAGING-LIMITS-UI) resolution precedence", () => {
  it("a stored row wins when no env override is set, and every source is settings", () => {
    const resolved = resolveForagingSettings({ stored: FULL_STORED, env: {} });
    expect(resolved.settings).toEqual(FULL_STORED);
    expect(Object.values(resolved.sources).every((source) => source === "settings")).toBe(true);
  });

  it("a set and readable env override beats the stored value key by key", () => {
    const resolved = resolveForagingSettings({
      stored: FULL_STORED,
      env: {
        [FORAGING_SETTINGS_ENV_KEYS.enabled]: "0",
        [FORAGING_SETTINGS_ENV_KEYS.dailyBudgetCents]: "500",
      },
    });
    expect(resolved.settings.enabled).toBe(false);
    expect(resolved.settings.dailyBudgetCents).toBe(500);
    // Untouched keys keep the stored value.
    expect(resolved.settings.intervalSec).toBe(7200);
    expect(resolved.settings.monthlyBudgetCents).toBe(10_000);
    expect(resolved.sources.enabled).toBe("env");
    expect(resolved.sources.dailyBudgetCents).toBe("env");
    expect(resolved.sources.intervalSec).toBe("settings");
    expect(resolved.sources.monthlyBudgetCents).toBe("settings");
  });

  it("an unreadable override (typo) leaves the stored value in force", () => {
    const resolved = resolveForagingSettings({
      stored: FULL_STORED,
      env: { [FORAGING_SETTINGS_ENV_KEYS.enabled]: "maybe" },
    });
    expect(resolved.settings.enabled).toBe(true);
    // The variable IS set, so the source is still env for that key.
    expect(resolved.sources.enabled).toBe("env");
  });

  it("no row and no env: the defaults, every source is default", () => {
    const resolved = resolveForagingSettings({ stored: undefined, env: {} });
    expect(resolved.settings.enabled).toBe(false);
    expect(resolved.settings.passBudgetCents).toBe(DEFAULT_FORAGING_PASS_BUDGET_CENTS);
    expect(Object.values(resolved.sources).every((source) => source === "default")).toBe(true);
  });

  it("an unreadable stored row counts as absent, so the env applies", () => {
    const resolved = resolveForagingSettings({
      stored: { enabled: "yes", intervalSec: -1 },
      env: { [FORAGING_SETTINGS_ENV_KEYS.enabled]: "1" },
    });
    expect(resolved.settings.enabled).toBe(true);
    expect(resolved.sources.enabled).toBe("env");
    expect(resolved.settings.intervalSec).toBe(DEFAULT_FORAGING_INTERVAL_SEC);
  });
});

describe("myrmidon(1.6.1-FORAGING-LIMITS-UI) stored value rules", () => {
  it("normalizes a valid row and rejects anything else", () => {
    expect(normalizeForagingSettings(FULL_STORED)).toEqual(FULL_STORED);
    expect(normalizeForagingSettings({ ...FULL_STORED, extra: 1 })).toBeNull();
    expect(normalizeForagingSettings({ enabled: true })).toBeNull();
    expect(normalizeForagingSettings(null)).toBeNull();
  });

  it("a ceiling is a positive integer or null, never zero or negative", () => {
    expect(normalizeForagingSettings({ ...FULL_STORED, dailyBudgetCents: 0 })).toBeNull();
    expect(normalizeForagingSettings({ ...FULL_STORED, dailyBudgetCents: -10 })).toBeNull();
    expect(normalizeForagingSettings({ ...FULL_STORED, dailyBudgetCents: null })).toEqual({
      ...FULL_STORED,
      dailyBudgetCents: null,
    });
  });
});

describe("myrmidon(1.6.1-FORAGING-LIMITS-UI) patch merge", () => {
  it("absent keys keep their value; null switches a ceiling off", () => {
    const next = mergeForagingSettings(FULL_STORED, {
      enabled: false,
      dailyBudgetCents: null,
    });
    expect(next).toEqual({
      ...FULL_STORED,
      enabled: false,
      dailyBudgetCents: null,
    });
  });

  it("an enforcement patch changes the mode", () => {
    const next = mergeForagingSettings(FULL_STORED, { enforcement: "hard" });
    expect(next.enforcement).toBe("hard");
  });
});

describe("myrmidon(1.6.1-FORAGING-LIMITS-UI) env key registry", () => {
  it("covers every setting key that has a variable", () => {
    // The resolver maps every non-enum key through this registry; a key
    // missing here would silently answer "default" for a set variable.
    const keysWithEnv = [
      "enabled",
      "intervalSec",
      "minHostIntervalSec",
      "passBudgetCents",
      "dailyBudgetCents",
      "monthlyBudgetCents",
      "roleBudgetCents",
      "agentBudgetCents",
    ];
    for (const key of keysWithEnv) {
      expect(FORAGING_SETTINGS_ENV_KEYS[key as keyof typeof FORAGING_SETTINGS_ENV_KEYS]).toBeTruthy();
    }
    expect(FORAGING_ENFORCEMENT_ENV).toBe("MYRMIDON_FORAGING_ENFORCEMENT");
    expect(FORAGING_AUTO_OFF_COST_PER_TASK_ENV).toBe(
      "MYRMIDON_FORAGING_AUTO_OFF_COST_PER_TASK_CENTS",
    );
  });
});
