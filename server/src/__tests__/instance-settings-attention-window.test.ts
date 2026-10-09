// ATTENTION-WINDOW-CACHE: the attention horizon/TTL keys must roundtrip through
// updateGeneral/getGeneral (they were accepted by the validator but dropped by
// the normalizeGeneralSettings whitelist).
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { instanceSettingsService } from "../services/instance-settings.js";

function stubDb(general: Record<string, unknown>) {
  let row: Record<string, unknown> = {
    id: "row-1",
    singletonKey: "default",
    defaultEnvironmentId: null,
    general,
    experimental: {},
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  };
  const db = {
    select: () => ({ from: () => ({ where: () => Promise.resolve([row]) }) }),
    insert: () => {
      throw new Error("unexpected insert in test");
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        row = { ...row, ...values };
        return { where: () => ({ returning: () => Promise.resolve([row]) }) };
      },
    }),
  } as unknown as Db;
  return db;
}

describe("instance settings: attention window and cache keys", () => {
  it("PATCH -> GET roundtrips both keys", async () => {
    const svc = instanceSettingsService(stubDb({}), { runtimeEnv: {} });
    const updated = await svc.updateGeneral({
      attentionFailedRunHorizonDays: 30,
      attentionFeedCacheTtlSeconds: 0,
    });
    expect(updated.general.attentionFailedRunHorizonDays).toBe(30);
    expect(updated.general.attentionFeedCacheTtlSeconds).toBe(0);
    const read = await svc.getGeneral();
    expect(read.attentionFailedRunHorizonDays).toBe(30);
    expect(read.attentionFeedCacheTtlSeconds).toBe(0);
  });

  it("an unrelated general write keeps a hand-set value", async () => {
    const svc = instanceSettingsService(
      stubDb({ attentionFailedRunHorizonDays: 365, attentionFeedCacheTtlSeconds: 120 }),
      { runtimeEnv: {} },
    );
    await svc.updateGeneral({ censorUsernameInLogs: true });
    const read = await svc.getGeneral();
    expect(read.censorUsernameInLogs).toBe(true);
    expect(read.attentionFailedRunHorizonDays).toBe(365);
    expect(read.attentionFeedCacheTtlSeconds).toBe(120);
  });

  it("leaves the keys absent when nobody set them", async () => {
    const svc = instanceSettingsService(stubDb({}), { runtimeEnv: {} });
    const read = await svc.getGeneral();
    expect(read).not.toHaveProperty("attentionFailedRunHorizonDays");
    expect(read).not.toHaveProperty("attentionFeedCacheTtlSeconds");
  });
});
