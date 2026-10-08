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
function stubDb(row: Record<string, unknown>) {
  const persistedSets: Array<Record<string, unknown>> = [];
  let state = { ...row };
  const db = {
    select: () => ({ from: () => ({ where: () => Promise.resolve([state]) }) }),
    insert: () => {
      throw new Error("unexpected insert in test");
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        persistedSets.push(values);
        state = { ...state, ...values };
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

describe("myrmidon(1.6.3-FORAGING-IDLE-GATE) the idle-gate toggle through updateGeneral", () => {
  it("persists every flip of the switch, not only the first one", async () => {
    const { db, persistedSets } = stubDb(settingsRow({}));
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
    const { db, persistedSets } = stubDb(
      settingsRow({ foragingIdleGate: { enabled: false }, foragingPassJournal: [JOURNAL_ENTRY] }),
    );

    await instanceSettingsService(db, { runtimeEnv: {} }).updateGeneral({});

    const general = persistedSets.at(-1)?.general as Record<string, unknown>;
    expect(general.foragingIdleGate).toEqual({ enabled: false });
    expect(general.foragingPassJournal).toEqual([JOURNAL_ENTRY]);
  });

  it("a toggle write does not drop the pass journal", async () => {
    const { db, persistedSets } = stubDb(
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
    const { db, persistedSets } = stubDb(settingsRow({}));
    await instanceSettingsService(db, { runtimeEnv: {} }).updateGeneral({
      foragingIdleGate: { enabled: true },
    });

    // The normalizer of `general` carried the key twice before the review fix;
    // one save is one write of the row.
    expect(persistedSets).toHaveLength(1);
  });
});