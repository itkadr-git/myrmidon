import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { SESSION_GENERATIONS_SETTINGS_KEY, instanceGeneralSettingsSchema } from "@paperclipai/shared";
import { instanceSettingsService } from "../../services/instance-settings.js";

// myrmidon(PERF-DIET-K): the service half of the session-generations settings. The
// run dispatch reads `general.sessions` through getGeneral(), and the settings panel
// writes it through updateGeneral(); both go through the normalizer, which drops
// every key it does not list. These tests run the real service over a stubbed row.

const STORED = { enabled: false, maxMessages: 100, maxDays: 7 };

// updateGeneral reads the row through select().from().where().limit(1).for("update")
// inside db.transaction (myrmidon PROCS-Q5); one Promise with chainable no-ops covers
// both the plain and the locking read.
function stubRows<T>(values: T[]) {
  const p = Promise.resolve(values) as Promise<T[]> & {
    limit(_n?: number): Promise<T[]>;
    for(_mode?: string): Promise<T[]>;
  };
  p.limit = () => p;
  p.for = () => p;
  return p;
}

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
  const db = {
    // No isolation in this stub: the transaction callback gets the same object back.
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

describe("myrmidon(PERF-DIET-K) instance settings service", () => {
  it("serves the declared key in the general schema", () => {
    expect(instanceGeneralSettingsSchema.shape).toHaveProperty(SESSION_GENERATIONS_SETTINGS_KEY);
  });

  it("carries sessions through a real updateGeneral patch and reads it back", async () => {
    const { db, readGeneral } = stubDb({});
    const svc = instanceSettingsService(db);
    await svc.updateGeneral({ [SESSION_GENERATIONS_SETTINGS_KEY]: STORED });
    expect(readGeneral()[SESSION_GENERATIONS_SETTINGS_KEY]).toEqual(STORED);
    await expect(svc.getGeneral()).resolves.toMatchObject({ [SESSION_GENERATIONS_SETTINGS_KEY]: STORED });
  });

  it("preserves the stored key across a patch of other keys", async () => {
    const { db, readGeneral } = stubDb({ [SESSION_GENERATIONS_SETTINGS_KEY]: STORED });
    const svc = instanceSettingsService(db);
    await svc.updateGeneral({ keyboardShortcuts: true });
    expect(readGeneral()[SESSION_GENERATIONS_SETTINGS_KEY]).toEqual(STORED);
  });
});
