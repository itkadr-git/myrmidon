import { describe, expect, it, vi } from "vitest";
import { DEFAULT_TEAM_LIVENESS_SETTINGS, TEAM_LIVENESS_ENV_KEYS } from "@paperclipai/shared";
import { createTeamLivenessReader } from "./settings.js";

// TEAM-LIVENESS-SETTINGS: the reader the three sweeps consult on every pass.
// It resolves the stored row against the environment, so a saved change takes
// effect without a restart and a key nobody saved keeps following the
// environment.

function readerFor(general: Record<string, unknown>, env: Record<string, string | undefined> = {}) {
  const getGeneral = vi.fn(async () => general);
  return { reader: createTeamLivenessReader({ settings: { getGeneral } as never, env }), getGeneral };
}

describe("team liveness settings reader", () => {
  it("reads the stored row on every call, so a save applies without a restart", async () => {
    const general: Record<string, unknown> = { teamLiveness: { idlePickupWakeBudgetPerMin: 2 } };
    const getGeneral = vi.fn(async () => general);
    const reader = createTeamLivenessReader({ settings: { getGeneral } as never, env: {} });

    const first = await reader();
    expect(first.settings.idlePickupWakeBudgetPerMin).toBe(2);
    expect(first.sources.idlePickupWakeBudgetPerMin).toBe("settings");

    // The operator saves another value: the next pass sees it.
    general.teamLiveness = { idlePickupWakeBudgetPerMin: 4 };
    const second = await reader();
    expect(second.settings.idlePickupWakeBudgetPerMin).toBe(4);
    expect(getGeneral).toHaveBeenCalledTimes(2);
  });

  it("falls back to the environment and then the default for keys nobody saved", async () => {
    const { reader } = readerFor(
      { teamLiveness: { runStallThresholdSec: 1200 } },
      { [TEAM_LIVENESS_ENV_KEYS.idlePickupWakeBatch]: "2" },
    );

    const resolved = await reader();

    expect(resolved.sources.runStallThresholdSec).toBe("settings");
    expect(resolved.sources.idlePickupWakeBatch).toBe("env");
    expect(resolved.settings.idlePickupWakeBatch).toBe(2);
    expect(resolved.sources.autoResumeEnabled).toBe("default");
    expect(resolved.settings.autoResumeEnabled).toBe(DEFAULT_TEAM_LIVENESS_SETTINGS.autoResumeEnabled);
  });

  it("survives a general row that is not an object", async () => {
    const { reader } = readerFor({ teamLiveness: "off" });
    const resolved = await reader();
    expect(resolved.settings).toEqual(DEFAULT_TEAM_LIVENESS_SETTINGS);
    expect(resolved.sources.idlePickupEnabled).toBe("default");
  });
});