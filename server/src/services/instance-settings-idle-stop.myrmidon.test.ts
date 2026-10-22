// myrmidon(OPE-7898): the IDLE-STOP policy must round-trip through the general
// settings document. The normalizer of `general` whitelists its keys: a key it does
// not carry is dropped on read (getGeneral) and on write (updateGeneral), so the
// board setting would never reach the sweeper.
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { instanceSettingsService } from "./instance-settings.js";

/**
 * Mirrors the stub in `__tests__/instance-settings-operator-defaults.test.ts`:
 * only the drizzle chains the service walks, every `update().set()` payload
 * captured, and a row that reflects the writes, so a test can walk a sequence
 * of saves.
 */
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

function stubDb(row: Record<string, unknown>) {
  const persistedSets: Array<Record<string, unknown>> = [];
  // The row state starts `null`: an empty table, so `getOrCreateRow` takes its
  // insert branch (which on conflict — the row actually existing — must behave
  // like the real upsert and adopt the existing row, not blind-write over it).
  let state: Record<string, unknown> | null = null;
  const db = {
    // No isolation in this stub: the transaction callback gets the same object back.
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    select: () => ({ from: () => ({ where: () => stubRows(state === null ? [] : [state]) }) }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: () => ({
          // The on-conflict upsert of getOrCreateRow: the row already exists,
          // so the write touches only `updatedAt` and returns the stored row —
          // never the `general: {}` of the would-be insert.
          returning: () => {
            if (state !== null) return Promise.resolve([state]);
            state = { ...values };
            return Promise.resolve([state]);
          },
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        persistedSets.push(values);
        state = { ...(state ?? {}), ...values };
        return { where: () => ({ returning: () => Promise.resolve([state]) }) };
      },
    }),
  } as unknown as Db;
  return { db, persistedSets };
}

function settingsRow(general: Record<string, unknown>) {
  return {
    id: "row-1",
    singletonKey: "default",
    defaultEnvironmentId: null,
    general,
    experimental: {},
    createdAt: new Date("2026-10-08T00:00:00.000Z"),
    updatedAt: new Date("2026-10-08T00:00:00.000Z"),
  };
}

const JOURNAL_ENTRY = { at: "2026-10-08T01:00:00.000Z", companyId: "company-a" };

/**
 * Seed the stub table with the pre-existing row, then return the test handle.
 * The seed goes through the stub `insert` (the `getOrCreateRow` create path),
 * which is not a service write — it does not land in `persistedSets`, those
 * capture only the `update().set()` payloads of `updateGeneral`.
 */
async function stubSeededDb(row: Record<string, unknown>) {
  const stub = stubDb(row);
  const insert = stub.db.insert as unknown as () => {
    values: (values: Record<string, unknown>) => {
      onConflictDoUpdate: () => { returning: () => Promise<Record<string, unknown>[]> };
    };
  };
  await insert().values(row).onConflictDoUpdate().returning();
  return stub;
}


describe("myrmidon(OPE-7898) the IDLE-STOP policy through the general settings", () => {
  it("getGeneral returns the stored policy", async () => {
    const stored = { enabled: false, afterSec: 3600, healthTimeoutMs: 120000 };
    const { db } = await stubSeededDb(settingsRow({ idleStop: stored }));
    const general = await instanceSettingsService(db, { runtimeEnv: {} }).getGeneral();
    expect(general.idleStop).toEqual(stored);
  });

  it("persists every save, the patch wins over the stored value", async () => {
    const { db, persistedSets } = await stubSeededDb(settingsRow({}));
    const service = instanceSettingsService(db, { runtimeEnv: {} });
    const a = { enabled: true, afterSec: 1800, healthTimeoutMs: 30000 };
    const b = { enabled: false, afterSec: 600, healthTimeoutMs: 60000 };
    await service.updateGeneral({ idleStop: a });
    await service.updateGeneral({ idleStop: b });
    await service.updateGeneral({ idleStop: a });
    expect(persistedSets.map((set) => (set.general as Record<string, unknown>).idleStop)).toEqual([a, b, a]);
  });

  it("an unrelated write keeps the stored policy", async () => {
    const stored = { enabled: true, afterSec: 900, healthTimeoutMs: 45000 };
    const { db, persistedSets } = await stubSeededDb(settingsRow({ idleStop: stored }));
    await instanceSettingsService(db, { runtimeEnv: {} }).updateGeneral({ keyboardShortcuts: true });
    expect((persistedSets.at(-1)?.general as Record<string, unknown>).idleStop).toEqual(stored);
  });
});
