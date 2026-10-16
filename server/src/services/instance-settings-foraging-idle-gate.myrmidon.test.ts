// myrmidon(1.6.3-FORAGING-IDLE-GATE): the review regression of 08.10 — the
// toggle of the "Foraging" page must round-trip through `updateGeneral`.
//
// The preserve line that keeps the stored key across every vendor write was
// spread AFTER `...nextGeneral` with no "the patch wins" line, so the second
// flip of the switch persisted the row and was immediately overwritten by the
// STORED value: on → off → on stayed at the value of the first click (and the
// first click worked, because nothing was stored yet). These tests walk a
// sequence of saves the way the settings page does and assert what the row
// holds after each one.
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

describe("myrmidon(1.6.3-FORAGING-IDLE-GATE) the idle-gate toggle through updateGeneral", () => {
  it("persists every flip of the switch, not only the first one", async () => {
    const { db, persistedSets } = await stubSeededDb(settingsRow({}));
    const service = instanceSettingsService(db, { runtimeEnv: {} });

    await service.updateGeneral({ foragingIdleGate: { enabled: false } });
    await service.updateGeneral({ foragingIdleGate: { enabled: true } });
    await service.updateGeneral({ foragingIdleGate: { enabled: false } });

    // Without the "a patch that carries the key wins" line every save after
    // the first would write the stored value back: false, false, false.
    expect(persistedSets.map((set) => (set.general as Record<string, unknown>).foragingIdleGate)).toEqual([
      { enabled: false },
      { enabled: true },
      { enabled: false },
    ]);
  });

  it("keeps the stored toggle and the pass journal across an unrelated general write", async () => {
    const { db, persistedSets } = await stubSeededDb(
      settingsRow({ foragingIdleGate: { enabled: false }, foragingPassJournal: [JOURNAL_ENTRY] }),
    );

    await instanceSettingsService(db, { runtimeEnv: {} }).updateGeneral({});

    const general = persistedSets.at(-1)?.general as Record<string, unknown>;
    expect(general.foragingIdleGate).toEqual({ enabled: false });
    expect(general.foragingPassJournal).toEqual([JOURNAL_ENTRY]);
  });

  it("a toggle write does not drop the pass journal", async () => {
    const { db, persistedSets } = await stubSeededDb(
      settingsRow({ foragingIdleGate: { enabled: true }, foragingPassJournal: [JOURNAL_ENTRY] }),
    );

    await instanceSettingsService(db, { runtimeEnv: {} }).updateGeneral({
      foragingIdleGate: { enabled: false },
    });

    const general = persistedSets.at(-1)?.general as Record<string, unknown>;
    expect(general.foragingIdleGate).toEqual({ enabled: false });
    expect(general.foragingPassJournal).toEqual([JOURNAL_ENTRY]);
  });

  it("writes the toggle exactly once per save", async () => {
    const { db, persistedSets } = await stubSeededDb(settingsRow({}));
    await instanceSettingsService(db, { runtimeEnv: {} }).updateGeneral({
      foragingIdleGate: { enabled: true },
    });

    // The normalizer of `general` carried the key twice before the review fix;
    // one save is one write of the row.
    expect(persistedSets).toHaveLength(1);
  });

  // OPE-6406: the review defect — PATCHing one setting must not change the
  // stored values of its neighbours. The switch edit of the Foraging page and
  // the general settings PATCH go through the same `updateGeneral`, so this is
  // the one contract that keeps every other settings key safe.
  it("PATCH of one setting keeps every neighbouring key stored in the row", async () => {
    // The neighbour values must be schema-valid: a stored row whose keys fail
    // the storage schema (`runStall` is `.strict()` with required fields, for
    // example) makes `normalizeGeneralSettings` fall back to defaults, which is
    // the failure class this test guards against being hidden by a fake shape.
    const neighbour = {
      censorUsernameInLogs: true,
      runStall: { enabled: false, thresholdSec: 900, checkIntervalSec: 60, pageSize: 50 },
      foraging: {
        enabled: false,
        intervalSec: 300,
        minHostIntervalSec: 60,
        passBudgetCents: 100,
        dailyBudgetCents: 1000,
        monthlyBudgetCents: 5000,
        roleBudgetCents: 500,
        agentBudgetCents: 200,
        enforcement: "hard" as const,
        autoOffCostPerTaskCents: null,
      },
      pauseGuard: { enabled: true },
      datastoreCare: { contextRetentionDays: 14 },
    };
    const { db, persistedSets } = await stubSeededDb(settingsRow({ ...neighbour }));

    // An unrelated PATCH — the shape the general settings page sends.
    await instanceSettingsService(db, { runtimeEnv: {} }).updateGeneral({
      keyboardShortcuts: true,
    });

    const general = persistedSets.at(-1)?.general as Record<string, unknown>;
    expect(general.keyboardShortcuts).toBe(true);
    for (const [key, value] of Object.entries(neighbour)) {
      expect(general[key], `neighbouring key "${key}" must survive`).toEqual(value);
    }
  });

  it("an idle-gate toggle write keeps every neighbouring key stored in the row", async () => {
    // Schema-valid neighbour shapes, as in the PATCH test above: the storage
    // schema is strict per key, and an invalid stored shape would make
    // `normalizeGeneralSettings` fall back to defaults before the row is read.
    const neighbour = {
      censorUsernameInLogs: true,
      runStall: { enabled: false, thresholdSec: 900, checkIntervalSec: 60, pageSize: 50 },
      foraging: {
        enabled: false,
        intervalSec: 300,
        minHostIntervalSec: 60,
        passBudgetCents: 100,
        dailyBudgetCents: 1000,
        monthlyBudgetCents: 5000,
        roleBudgetCents: 500,
        agentBudgetCents: 200,
        enforcement: "hard" as const,
        autoOffCostPerTaskCents: null,
      },
      datastoreCare: { contextRetentionDays: 14 },
    };
    const { db, persistedSets } = await stubSeededDb(
      settingsRow({ ...neighbour, foragingIdleGate: { enabled: true }, foragingPassJournal: [JOURNAL_ENTRY] }),
    );

    // The Foraging page switch — one key in the patch.
    await instanceSettingsService(db, { runtimeEnv: {} }).updateGeneral({
      foragingIdleGate: { enabled: false },
    });

    const general = persistedSets.at(-1)?.general as Record<string, unknown>;
    expect(general.foragingIdleGate).toEqual({ enabled: false });
    expect(general.foragingPassJournal).toEqual([JOURNAL_ENTRY]);
    for (const [key, value] of Object.entries(neighbour)) {
      expect(general[key], `neighbouring key "${key}" must survive the toggle write`).toEqual(value);
    }
  });
});