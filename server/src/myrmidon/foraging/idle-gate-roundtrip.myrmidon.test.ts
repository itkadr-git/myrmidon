// myrmidon(1.6.3-FORAGING-IDLE-GATE): the toggle goes through the REAL
// instanceSettingsService.updateGeneral (not a fake dep). Regression: a preserve
// line spread after the normalized patch restored the old stored value, so the
// second PATCH answered 200 and the row kept the first value.
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { foragingIdleGateService } from "./idle-gate-settings.js";

function stubDb() {
  let row: Record<string, unknown> = {
    id: "row-1",
    singletonKey: "default",
    defaultEnvironmentId: null,
    general: {},
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
  return { db, stored: () => (row.general as Record<string, unknown>).foragingIdleGate };
}

const ACTOR = {
  actorType: "user" as const,
  actorId: "u1",
  agentId: null,
  runId: null,
  agentApiKeyId: null,
};

describe("foraging idle gate: roundtrip through the real updateGeneral", () => {
  it("two PATCHes in a row: the second value wins in the stored row and in the read", async () => {
    const { db, stored } = stubDb();
    const service = foragingIdleGateService(db, { listCompanyIds: async () => [], env: {} });

    await service.update({ enabled: false }, ACTOR);
    expect(stored()).toEqual({ enabled: false });
    expect((await service.read()).enabled).toBe(false);

    await service.update({ enabled: true }, ACTOR);
    expect(stored()).toEqual({ enabled: true });
    const read = await service.read();
    expect(read.enabled).toBe(true);

    await service.update({ enabled: false }, ACTOR);
    expect(stored()).toEqual({ enabled: false });
    expect((await service.read()).enabled).toBe(false);
  });

  it("an unrelated general write keeps the stored toggle", async () => {
    const { db, stored } = stubDb();
    const service = foragingIdleGateService(db, { listCompanyIds: async () => [], env: {} });
    await service.update({ enabled: false }, ACTOR);
    await instanceSettingsService(db).updateGeneral({ censorUsernameInLogs: true });
    expect(stored()).toEqual({ enabled: false });
  });
});
