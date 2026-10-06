import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TEAM_LIVENESS_SETTINGS,
  TEAM_LIVENESS_ENV_KEYS,
} from "@paperclipai/shared";
import { teamLivenessService, TEAM_LIVENESS_ACTION } from "./service.js";

// TEAM-LIVENESS-SETTINGS: the settings service of the three automatic
// behaviours. The service must store only the keys an operator actually saved
// (so the environment keeps controlling the rest) and must audit every change
// for every company — the two traps this area of the instance settings has.

const ACTOR = {
  actorType: "user" as const,
  actorId: "user-1",
  agentId: null,
  runId: null,
  agentApiKeyId: null,
};

function harness(input: {
  general?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
}) {
  let general: Record<string, unknown> = { ...(input.general ?? {}) };
  const updateGeneral = vi.fn(async (patch: { teamLiveness: Record<string, unknown> }) => {
    general = { ...general, ...patch };
    return general;
  });
  // Typed through a rest parameter: the assertion below reads the entry the
  // service passed, and an argument-less mock would type `calls[0]` as [].
  const logActivity = vi.fn(async (..._args: unknown[]) => undefined);
  const service = teamLivenessService({} as never, {
    settings: {
      getGeneral: (async () => general) as never,
      updateGeneral: updateGeneral as never,
    },
    env: input.env ?? {},
    listCompanyIds: async () => ["company-a", "company-b"],
    logActivity: logActivity as never,
  });
  return { service, updateGeneral, logActivity, readGeneral: () => general };
}

describe("team liveness settings service", () => {
  it("reports the effective values, the saved keys and the layer in force", async () => {
    const { service } = harness({
      general: { teamLiveness: { idlePickupWakeBudgetPerMin: 2 } },
      env: { [TEAM_LIVENESS_ENV_KEYS.runStallThresholdSec]: "900" },
    });

    const view = await service.read();

    expect(view.settings.idlePickupWakeBudgetPerMin).toBe(2);
    expect(view.sources.idlePickupWakeBudgetPerMin).toBe("settings");
    expect(view.settings.runStallThresholdSec).toBe(900);
    expect(view.sources.runStallThresholdSec).toBe("env");
    expect(view.stored).toEqual({ idlePickupWakeBudgetPerMin: 2 });
    expect(view.defaults).toEqual(DEFAULT_TEAM_LIVENESS_SETTINGS);
  });

  it("reports an instance that never saved anything as environment-only", async () => {
    const { service } = harness({});
    const view = await service.read();
    expect(view.stored).toEqual({});
    expect(view.settings).toEqual(DEFAULT_TEAM_LIVENESS_SETTINGS);
    for (const source of Object.values(view.sources)) expect(source).toBe("default");
  });

  it("stores only what the operator saved and audits it for every company", async () => {
    const { service, updateGeneral, logActivity, readGeneral } = harness({});

    const view = await service.update({ idlePickupWakeBatch: 3 }, ACTOR);

    expect(updateGeneral).toHaveBeenCalledTimes(1);
    expect(readGeneral()).toEqual({ teamLiveness: { idlePickupWakeBatch: 3 } });
    expect(view.stored).toEqual({ idlePickupWakeBatch: 3 });
    expect(view.settings.idlePickupWakeBatch).toBe(3);
    expect(view.sources.idlePickupWakeBatch).toBe("settings");
    expect(logActivity).toHaveBeenCalledTimes(2);
    expect(logActivity.mock.calls[0]![0]).toMatchObject({
      companyId: "company-a",
      action: TEAM_LIVENESS_ACTION,
      entityType: "instance_settings",
      details: { next: { idlePickupWakeBatch: 3 }, changedKeys: ["idlePickupWakeBatch"] },
    });
  });

  it("never bakes an environment override into the stored row", async () => {
    const { service, updateGeneral, readGeneral } = harness({
      general: { teamLiveness: { autoResumeEnabled: false } },
      env: { [TEAM_LIVENESS_ENV_KEYS.runStallThresholdSec]: "900" },
    });

    const view = await service.update({ idlePickupIntervalSec: 45 }, ACTOR);

    // The threshold the environment controls stays unsaved, so removing the
    // variable later really takes effect.
    expect(readGeneral()).toEqual({
      teamLiveness: { autoResumeEnabled: false, idlePickupIntervalSec: 45 },
    });
    expect(updateGeneral).toHaveBeenCalledTimes(1);
    expect(view.stored).toEqual({ autoResumeEnabled: false, idlePickupIntervalSec: 45 });
    expect(view.settings.runStallThresholdSec).toBe(900);
    expect(view.sources.runStallThresholdSec).toBe("env");
  });

  it("writes nothing when the patch changes nothing, still answering with the view", async () => {
    const { service, updateGeneral, logActivity } = harness({
      general: { teamLiveness: { idlePickupEnabled: false } },
    });

    const view = await service.update({ idlePickupEnabled: false }, ACTOR);

    expect(updateGeneral).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
    expect(view.settings.idlePickupEnabled).toBe(false);
  });
});