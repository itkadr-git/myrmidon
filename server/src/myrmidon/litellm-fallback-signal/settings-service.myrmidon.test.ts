import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { FALLBACK_SIGNAL_SETTINGS_KEY, instanceGeneralSettingsSchema } from "@paperclipai/shared";
import { instanceSettingsService } from "../../services/instance-settings.js";

// myrmidon(BOT-RUNTIME-TUNING D2): the service half of the settings contract.
// The unit tests in settings.myrmidon.test.ts fake getGeneral/updateGeneral, so
// they never exercise the real normalizeGeneralSettings/merge path — which is
// exactly where the key was dropped and where the TS2353 lived. These tests run
// the real service over a stubbed row.

const STORED = {
  enabled: true,
  thresholdPct: 35,
  minCalls: 5,
  windowSec: 7200,
  intervalSec: 120,
};

function stubDb(general: Record<string, unknown>) {
  const row = {
    id: "row-1",
    singletonKey: "default",
    defaultEnvironmentId: null,
    general,
    experimental: {},
    createdAt: new Date("2026-10-06T00:00:00.000Z"),
    updatedAt: new Date("2026-10-06T00:00:00.000Z"),
  };
  // Awaitable result that also survives the myrmidon(PROCS-Q5) lock chain
  // `.limit(1).for("update")` before the row read in `getOrCreateRow`.
  const stubRows = <T,>(values: T[]) => {
    const p = Promise.resolve(values) as Promise<T[]> & {
      limit(_n?: number): Promise<T[]>;
      for(_mode?: string): Promise<T[]>;
    };
    p.limit = () => p;
    p.for = () => p;
    return p;
  };
  const db = {
    // myrmidon(PROCS-Q5): updateGeneral reads and writes inside a transaction.
    // The stub has no isolation; the callback gets the same object back.
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    select: () => ({ from: () => ({ where: () => stubRows([row]) }) }),
    insert: () => {
      throw new Error("unexpected insert in test");
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        Object.assign(row, values);
        return { where: () => ({ returning: () => Promise.resolve([row]) }) };
      },
    }),
  } as unknown as Db;
  return { db, readGeneral: () => row.general as Record<string, unknown> };
}

describe("myrmidon(BOT-RUNTIME-TUNING D2) instance settings service", () => {
  it("serves the declared key in the general schema", () => {
    expect(instanceGeneralSettingsSchema.shape).toHaveProperty(FALLBACK_SIGNAL_SETTINGS_KEY);
  });

  it("carries modelFallbackSignal through a real updateGeneral patch", async () => {
    const { db, readGeneral } = stubDb({});
    const svc = instanceSettingsService(db);
    await svc.updateGeneral({ [FALLBACK_SIGNAL_SETTINGS_KEY]: STORED });
    expect(readGeneral()[FALLBACK_SIGNAL_SETTINGS_KEY]).toEqual(STORED);
    await expect(svc.getGeneral()).resolves.toMatchObject({
      [FALLBACK_SIGNAL_SETTINGS_KEY]: STORED,
    });
  });

  it("replaces the stored value when a later patch carries the key", async () => {
    const { db, readGeneral } = stubDb({ [FALLBACK_SIGNAL_SETTINGS_KEY]: STORED });
    const svc = instanceSettingsService(db);
    await svc.updateGeneral({ [FALLBACK_SIGNAL_SETTINGS_KEY]: { thresholdPct: 10 } });
    expect(readGeneral()[FALLBACK_SIGNAL_SETTINGS_KEY]).toEqual({ thresholdPct: 10 });
  });

  it("preserves the stored key across a patch of other keys", async () => {
    const { db, readGeneral } = stubDb({ [FALLBACK_SIGNAL_SETTINGS_KEY]: STORED });
    const svc = instanceSettingsService(db);
    await svc.updateGeneral({ keyboardShortcuts: true });
    expect(readGeneral()[FALLBACK_SIGNAL_SETTINGS_KEY]).toEqual(STORED);
  });
});
