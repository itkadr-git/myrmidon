import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEAM_LIVENESS_SETTINGS,
  TEAM_LIVENESS_CARD_KEY,
  TEAM_LIVENESS_ENV_KEYS,
  envDeclaresTeamLivenessKey,
  mergeTeamLiveness,
  patchTeamLivenessSettingsSchema,
  readAgentTeamLivenessCard,
  readTeamLivenessFromEnv,
  resolveAgentTeamLiveness,
  resolveTeamLivenessSettings,
  storedTeamLivenessSettingsSchema,
} from "./myrmidon-team-liveness.js";

// TEAM-LIVENESS-SETTINGS: the knobs of the three automatic behaviours
// (auto-resume, progress-based run liveness, wake-on-ready-work). The resolver
// decides per key whether the stored settings, the environment or the default
// is in force — and the settings page shows that decision, so a value the
// environment does not actually control must never be reported as "env".

const ALL_ENV_OFF = {
  [TEAM_LIVENESS_ENV_KEYS.autoResumeEnabled]: "0",
  [TEAM_LIVENESS_ENV_KEYS.runStallEnabled]: "off",
  [TEAM_LIVENESS_ENV_KEYS.idlePickupEnabled]: "false",
};

describe("team liveness defaults", () => {
  it("keeps all three behaviours on with the ticket's numbers", () => {
    const { settings, sources } = resolveTeamLivenessSettings({ env: {} });
    expect(settings).toEqual(DEFAULT_TEAM_LIVENESS_SETTINGS);
    expect(DEFAULT_TEAM_LIVENESS_SETTINGS.autoResumeEnabled).toBe(true);
    expect(DEFAULT_TEAM_LIVENESS_SETTINGS.runStallEnabled).toBe(true);
    expect(DEFAULT_TEAM_LIVENESS_SETTINGS.idlePickupEnabled).toBe(true);
    // "At most five wakes a minute, in batches" — the ticket's own ceiling.
    expect(DEFAULT_TEAM_LIVENESS_SETTINGS.idlePickupWakeBudgetPerMin).toBe(5);
    expect(DEFAULT_TEAM_LIVENESS_SETTINGS.idlePickupWakeBatch).toBe(5);
    expect(DEFAULT_TEAM_LIVENESS_SETTINGS.runStallThresholdSec).toBe(1_200);
    expect(DEFAULT_TEAM_LIVENESS_SETTINGS.idlePickupIntervalSec).toBe(30);
    for (const source of Object.values(sources)) expect(source).toBe("default");
  });

  it("reads the switches and the numbers from the environment", () => {
    const { settings, sources } = resolveTeamLivenessSettings({
      env: {
        ...ALL_ENV_OFF,
        [TEAM_LIVENESS_ENV_KEYS.runStallThresholdSec]: "900",
        [TEAM_LIVENESS_ENV_KEYS.idlePickupIntervalSec]: "15",
        [TEAM_LIVENESS_ENV_KEYS.idlePickupWakeBudgetPerMin]: "3",
        [TEAM_LIVENESS_ENV_KEYS.idlePickupWakeBatch]: "2",
      },
    });
    expect(settings).toMatchObject({
      autoResumeEnabled: false,
      runStallEnabled: false,
      idlePickupEnabled: false,
      runStallThresholdSec: 900,
      idlePickupIntervalSec: 15,
      idlePickupWakeBudgetPerMin: 3,
      idlePickupWakeBatch: 2,
    });
    for (const source of Object.values(sources)) expect(source).toBe("env");
  });
});

describe("team liveness precedence", () => {
  it("lets a stored value beat the environment, per key", () => {
    const { settings, sources } = resolveTeamLivenessSettings({
      stored: { idlePickupEnabled: true, idlePickupWakeBudgetPerMin: 2 },
      env: {
        ...ALL_ENV_OFF,
        [TEAM_LIVENESS_ENV_KEYS.idlePickupWakeBudgetPerMin]: "9",
      },
    });
    expect(settings.idlePickupEnabled).toBe(true);
    expect(sources.idlePickupEnabled).toBe("settings");
    expect(settings.idlePickupWakeBudgetPerMin).toBe(2);
    expect(sources.idlePickupWakeBudgetPerMin).toBe("settings");
    // The keys nobody saved still come from the environment.
    expect(settings.autoResumeEnabled).toBe(false);
    expect(sources.autoResumeEnabled).toBe("env");
  });

  it("keeps the default when the environment holds a value it would reject", () => {
    const { settings, sources } = resolveTeamLivenessSettings({
      env: {
        // Out of the 60..86400 range, and a switch that is neither on nor off.
        [TEAM_LIVENESS_ENV_KEYS.runStallThresholdSec]: "10",
        [TEAM_LIVENESS_ENV_KEYS.autoResumeEnabled]: "maybe",
      },
    });
    expect(settings.runStallThresholdSec).toBe(DEFAULT_TEAM_LIVENESS_SETTINGS.runStallThresholdSec);
    expect(settings.autoResumeEnabled).toBe(true);
    // A field the environment does not control must not be reported as "env".
    expect(sources.runStallThresholdSec).toBe("default");
    expect(sources.autoResumeEnabled).toBe("default");
    expect(envDeclaresTeamLivenessKey("runStallThresholdSec", {
      [TEAM_LIVENESS_ENV_KEYS.runStallThresholdSec]: "10",
    })).toBe(false);
    expect(envDeclaresTeamLivenessKey("runStallThresholdSec", {
      [TEAM_LIVENESS_ENV_KEYS.runStallThresholdSec]: "900",
    })).toBe(true);
    expect(envDeclaresTeamLivenessKey("idlePickupIntervalSec", {})).toBe(false);
    expect(
      envDeclaresTeamLivenessKey("idlePickupIntervalSec", {
        [TEAM_LIVENESS_ENV_KEYS.idlePickupIntervalSec]: "   ",
      }),
    ).toBe(false);
  });

  it("ignores a stored value out of range and falls back to the environment", () => {
    const { settings, sources } = resolveTeamLivenessSettings({
      stored: { runStallThresholdSec: 30 },
      env: { [TEAM_LIVENESS_ENV_KEYS.runStallThresholdSec]: "900" },
    });
    expect(settings.runStallThresholdSec).toBe(900);
    expect(sources.runStallThresholdSec).toBe("env");
  });

  it("never lets a pass spend more of the minute than the minute holds", () => {
    const { settings } = resolveTeamLivenessSettings({
      stored: { idlePickupWakeBudgetPerMin: 2, idlePickupWakeBatch: 10 },
    });
    expect(settings.idlePickupWakeBatch).toBe(2);
    const byEnv = readTeamLivenessFromEnv({
      [TEAM_LIVENESS_ENV_KEYS.idlePickupWakeBudgetPerMin]: "1",
      [TEAM_LIVENESS_ENV_KEYS.idlePickupWakeBatch]: "5",
    });
    expect(byEnv.idlePickupWakeBatch).toBe(1);
  });

  it("merges a patch onto the effective values, ignoring keys it does not carry", () => {
    const merged = mergeTeamLiveness(DEFAULT_TEAM_LIVENESS_SETTINGS, {
      idlePickupEnabled: false,
      runStallThresholdSec: 900,
    });
    expect(merged).toMatchObject({
      idlePickupEnabled: false,
      runStallThresholdSec: 900,
      autoResumeEnabled: true,
      idlePickupIntervalSec: DEFAULT_TEAM_LIVENESS_SETTINGS.idlePickupIntervalSec,
    });
    // The same invariant as the resolver: a batch never exceeds its ceiling.
    expect(mergeTeamLiveness(DEFAULT_TEAM_LIVENESS_SETTINGS, { idlePickupWakeBudgetPerMin: 1 }).idlePickupWakeBatch)
      .toBe(1);
  });

  it("accepts a partial stored row and rejects an unknown key", () => {
    expect(storedTeamLivenessSettingsSchema.safeParse({ idlePickupEnabled: false }).success).toBe(true);
    expect(storedTeamLivenessSettingsSchema.safeParse({}).success).toBe(true);
    expect(storedTeamLivenessSettingsSchema.safeParse({ nope: true }).success).toBe(false);
    expect(patchTeamLivenessSettingsSchema.safeParse({ runStallThresholdSec: 0 }).success).toBe(false);
    // A hand-edited row that cannot be parsed leaves every key at its other layer.
    const { settings, sources } = resolveTeamLivenessSettings({ stored: { idlePickupEnabled: "yes" } });
    expect(settings.idlePickupEnabled).toBe(true);
    expect(sources.idlePickupEnabled).toBe("default");
  });
});

describe("team liveness per-agent card", () => {
  const settings = { ...DEFAULT_TEAM_LIVENESS_SETTINGS, idlePickupEnabled: true };

  it("follows the instance value when the card says nothing", () => {
    expect(readAgentTeamLivenessCard({})).toEqual({});
    expect(resolveAgentTeamLiveness({}, settings)).toEqual({
      autoResumeEnabled: true,
      runStallEnabled: true,
      idlePickupEnabled: true,
    });
    const off = { ...settings, idlePickupEnabled: false };
    expect(resolveAgentTeamLiveness({}, off).idlePickupEnabled).toBe(false);
  });

  it("lets one agent switch a behaviour off for itself", () => {
    const card = { [TEAM_LIVENESS_CARD_KEY]: { idlePickup: false, runStall: false } };
    expect(resolveAgentTeamLiveness(card, settings)).toEqual({
      autoResumeEnabled: true,
      runStallEnabled: false,
      idlePickupEnabled: false,
    });
    // An explicit "on" on the card beats an instance "off".
    const off = { ...settings, autoResumeEnabled: false };
    expect(
      resolveAgentTeamLiveness({ [TEAM_LIVENESS_CARD_KEY]: { autoResume: true } }, off).autoResumeEnabled,
    ).toBe(true);
  });

  it("reads an unreadable block as no override, including a card with numbers", () => {
    // The card may not carry the company-wide numbers: an agent must not be
    // able to raise the wake ceiling, and a block carrying them is not a card
    // this module understands.
    expect(readAgentTeamLivenessCard({ [TEAM_LIVENESS_CARD_KEY]: "off" })).toEqual({});
    expect(
      readAgentTeamLivenessCard({ [TEAM_LIVENESS_CARD_KEY]: { idlePickup: false, wakeBudgetPerMin: 99 } }),
    ).toEqual({});
    expect(
      resolveAgentTeamLiveness({ [TEAM_LIVENESS_CARD_KEY]: { wakeBudgetPerMin: 99 } }, settings)
        .idlePickupEnabled,
    ).toBe(true);
  });
});