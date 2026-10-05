import { beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateTelegramDmProgressSettingsCache, readTelegramDmProgressSettings } from "./settings.js";
import { TELEGRAM_DM_PROGRESS_ACTION, telegramDmProgressService } from "./service.js";

// myrmidon(DM-PROGRESS): the settings service behind
// GET/PATCH /api/myrmidon/telegram-dm-progress — merge, write, audit for
// every company, and the sweep sees the change without a restart.

describe("telegramDmProgressService", () => {
  beforeEach(() => invalidateTelegramDmProgressSettingsCache());

  const actor = { actorType: "user" as const, actorId: "user-a", agentId: null, runId: null, agentApiKeyId: null };

  it("merges the patch, writes it, audits it for every company and drops the sweep cache", async () => {
    let general: Record<string, unknown> = { telegramDmProgress: { enabled: true, intervalSec: 60 } };
    const updateGeneral = vi.fn(async (patch: Record<string, unknown>) => {
      general = { ...general, ...patch };
      return general;
    });
    const logActivity = vi.fn(async () => undefined);
    const service = telegramDmProgressService({} as never, {
      getGeneral: async () => general,
      updateGeneral,
      listCompanyIds: async () => ["company-a", "company-b"],
      logActivity,
      env: {},
    });

    // Warm the sweep cache with the old value.
    expect((await readTelegramDmProgressSettings({ getGeneral: async () => general, env: {} })).intervalSec).toBe(60);

    const view = await service.update({ intervalSec: 30 }, actor);
    expect(updateGeneral).toHaveBeenCalledWith({ telegramDmProgress: { enabled: true, intervalSec: 30 } });
    expect(view).toEqual({ enabled: true, enabledSource: "settings", intervalSec: 30, intervalSource: "settings" });
    expect(logActivity).toHaveBeenCalledTimes(2);
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-b",
        actorId: "user-a",
        action: TELEGRAM_DM_PROGRESS_ACTION,
        entityType: "instance_settings",
        entityId: "telegramDmProgress",
        details: { settings: { enabled: true, intervalSec: 30 }, patch: { intervalSec: 30 } },
      }),
    );
    // The next sweep read sees the new value at once.
    expect((await readTelegramDmProgressSettings({ getGeneral: async () => general, env: {} })).intervalSec).toBe(30);
  });

  it("reports an environment override as the source in force", async () => {
    const service = telegramDmProgressService({} as never, {
      getGeneral: async () => ({ telegramDmProgress: { enabled: true } }),
      updateGeneral: vi.fn(async () => undefined),
      listCompanyIds: async () => [],
      logActivity: vi.fn(async () => undefined),
      env: { MYRMIDON_TELEGRAM_DM_PROGRESS: "off" },
    });
    expect(await service.read()).toMatchObject({ enabled: false, enabledSource: "env" });
    expect(await service.update({ enabled: true }, actor)).toMatchObject({ enabled: false, enabledSource: "env" });
  });
});
