import { describe, expect, it, afterEach } from "vitest";
import { behaviorSettingRegistry } from "@myrmidon/shared";
import { applyLiveBehaviorSettings, liveBehaviorSettingsView } from "./live.js";
import { foragingMasterEnabled, resolveForagingEffectiveSettings } from "../foraging/settings.js";
import { baselineMasterEnabled, readBaselineSettings } from "../baseline/startup.js";
import { ctoChatSettingsProblem, readCtoChatSettings } from "../cto-chat/settings.js";
import { evalsSettingsProblem, readEvalsSettings } from "../evals/judge.js";

const FORAGING_STORED = {
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

const configuredEnv = {
  MYRMIDON_CTO_CHAT_BASE_URL: "https://planner.example",
  MYRMIDON_CTO_CHAT_KEY_SECRET: "planner-key",
  MYRMIDON_EVALS_BASE_URL: "https://evals.example",
  MYRMIDON_EVALS_KEY_SECRET: "evals-key",
};

const settingsPort = (general: Record<string, unknown>) => ({
  getGeneral: async () => general,
});

const previousLive = liveBehaviorSettingsView();
afterEach(() => applyLiveBehaviorSettings(previousLive));

describe("myrmidon(OPE-12124) feature master switches", () => {
  it("registers all four first-party switches with env overrides and ON defaults", () => {
    expect(behaviorSettingRegistry.get("foragingEnabled")).toMatchObject({
      envName: "MYRMIDON_FORAGING_ENABLED",
      default: true,
    });
    expect(behaviorSettingRegistry.get("baselineEnabled")).toMatchObject({
      envName: "MYRMIDON_BASELINE_ENABLED",
      default: true,
    });
    expect(behaviorSettingRegistry.get("ctoChatEnabled")).toMatchObject({
      envName: "MYRMIDON_CTO_CHAT_ENABLED",
      default: true,
    });
    expect(behaviorSettingRegistry.get("evalsEnabled")).toMatchObject({
      envName: "MYRMIDON_EVALS_ENABLED",
      default: true,
    });
  });

  it("applies the foraging switch to the live sweep settings", async () => {
    const off = await resolveForagingEffectiveSettings(
      settingsPort({ foraging: FORAGING_STORED }) as never,
      { MYRMIDON_FORAGING_ENABLED: "false" },
    );
    expect(off.settings.enabled).toBe(false);

    expect(foragingMasterEnabled({ MYRMIDON_FORAGING_ENABLED: "true" })).toBe(true);
  });

  it("lets the environment override a UI-off baseline switch (env=true + UI=false => enabled=true)", () => {
    applyLiveBehaviorSettings({ settings: { baselineEnabled: false }, sources: { baselineEnabled: "ui" } as never });
    expect(baselineMasterEnabled({})).toBe(false);
    expect(readBaselineSettings({
      MYRMIDON_BASELINE_INTERVAL_SEC: "3600",
    }).enabled).toBe(false);

    expect(baselineMasterEnabled({ MYRMIDON_BASELINE_ENABLED: "true" })).toBe(true);
    expect(readBaselineSettings({
      MYRMIDON_BASELINE_ENABLED: "true",
      MYRMIDON_BASELINE_INTERVAL_SEC: "3600",
    })).toMatchObject({ enabled: true, intervalSec: 3600 });

    expect(baselineMasterEnabled({ MYRMIDON_BASELINE_ENABLED: "false" })).toBe(false);
    expect(readBaselineSettings({
      MYRMIDON_BASELINE_ENABLED: "false",
      MYRMIDON_BASELINE_INTERVAL_SEC: "3600",
    }).enabled).toBe(false);
  });

  it("lets the environment override a UI-on baseline switch (env=false + UI=true => enabled=false)", () => {
    applyLiveBehaviorSettings({ settings: { baselineEnabled: true }, sources: { baselineEnabled: "ui" } as never });
    expect(baselineMasterEnabled({})).toBe(true);
    expect(readBaselineSettings({
      MYRMIDON_BASELINE_INTERVAL_SEC: "3600",
    })).toMatchObject({ enabled: true, intervalSec: 3600 });

    expect(baselineMasterEnabled({ MYRMIDON_BASELINE_ENABLED: "false" })).toBe(false);
    expect(readBaselineSettings({
      MYRMIDON_BASELINE_ENABLED: "false",
      MYRMIDON_BASELINE_INTERVAL_SEC: "3600",
    }).enabled).toBe(false);

    expect(baselineMasterEnabled({ MYRMIDON_BASELINE_ENABLED: "true" })).toBe(true);
    expect(readBaselineSettings({
      MYRMIDON_BASELINE_ENABLED: "true",
      MYRMIDON_BASELINE_INTERVAL_SEC: "3600",
    })).toMatchObject({ enabled: true, intervalSec: 3600 });
  });

  it("turns off configured CTO chat and evals without a restart", () => {
    const cto = readCtoChatSettings({ ...configuredEnv, MYRMIDON_CTO_CHAT_ENABLED: "false" });
    expect(cto.enabled).toBe(false);
    expect(ctoChatSettingsProblem(cto)).toContain("ctoChatEnabled");

    const evals = readEvalsSettings({ ...configuredEnv, MYRMIDON_EVALS_ENABLED: "false" });
    expect(evals.enabled).toBe(false);
    expect(evalsSettingsProblem(evals)).toContain("evalsEnabled");
  });

  it("uses a saved UI value when no environment override is declared", () => {
    applyLiveBehaviorSettings({
      settings: { ctoChatEnabled: false, evalsEnabled: false },
      sources: { ctoChatEnabled: "ui", evalsEnabled: "ui" } as never,
    });
    expect(readCtoChatSettings(configuredEnv).enabled).toBe(false);
    expect(readEvalsSettings(configuredEnv).enabled).toBe(false);
  });
});
