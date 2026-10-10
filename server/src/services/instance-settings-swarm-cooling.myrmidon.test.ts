// myrmidon(1.6.5 SWARM-PANEL-COOLING, OPE-6894): the cooling block of the
// swarm panel saves `general.swarm` through the instance-general settings
// API. Two properties the issue names as red-side:
//   1. a save that writes `general.swarm` must NOT lose the stored
//      `general.swarmClaim` (the swarm settings live in the same row);
//   2. the written cooldown values round-trip through `normalizeGeneralSettings`
//      (the whitelist that drops unlisted keys — the historical failure mode
//      of every "own page inside general" feature).
// The stub harness mirrors instance-settings-foraging-idle-gate.myrmidon.test.ts.
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { instanceSettingsService } from "./instance-settings.js";

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
  let state: Record<string, unknown> | null = null;
  const db = {
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    select: () => ({ from: () => ({ where: () => stubRows(state === null ? [] : [state]) }) }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: () => ({
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
    createdAt: new Date("2026-10-09T00:00:00.000Z"),
    updatedAt: new Date("2026-10-09T00:00:00.000Z"),
  };
}

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

const STORED_SWARM_CLAIM = {
  enabled: true,
  leaseTtlSec: 900,
  maxActiveTasks: 3,
  sweepIntervalSec: 30,
  p0Preemption: true,
  pheromone: { critical: 250 },
};

describe("myrmidon(1.6.5 SWARM-PANEL-COOLING) the cooling block through updateGeneral", () => {
  it("writes general.swarm and keeps the stored general.swarmClaim", async () => {
    const { db } = await stubSeededDb(settingsRow({ swarmClaim: STORED_SWARM_CLAIM }));
    const service = instanceSettingsService(db, { runtimeEnv: {} });

    await service.updateGeneral({
      swarm: { cooldownBaseMin: 45, cooldownCeilingHours: 12, runWithoutTaskGate: true },
    });

    const general = (await service.getGeneral()) as Record<string, unknown>;
    expect(general.swarm).toEqual({
      cooldownBaseMin: 45,
      cooldownCeilingHours: 12,
      runWithoutTaskGate: true,
    });
    // red side: before OPE-6894 the read of a cooling save wiped the swarm —
    // the general document is rewritten wholesale, so the stored claim block
    // must survive it untouched.
    expect(general.swarmClaim).toEqual(STORED_SWARM_CLAIM);
  });

  it("a later claim save does not lose the cooling block, and vice versa", async () => {
    const { db } = await stubSeededDb(
      settingsRow({ swarmClaim: STORED_SWARM_CLAIM, swarm: { cooldownBaseMin: 45 } }),
    );
    const service = instanceSettingsService(db, { runtimeEnv: {} });

    // The swarm route PATCHes through the same general document (merge path):
    // a merge that keeps the stored swarmClaim must also keep general.swarm.
    await service.updateGeneral({ swarmClaim: { ...STORED_SWARM_CLAIM, leaseTtlSec: 600 } });
    let general = (await service.getGeneral()) as Record<string, unknown>;
    expect(general.swarm).toEqual({ cooldownBaseMin: 45 });
    expect((general.swarmClaim as Record<string, unknown>).leaseTtlSec).toBe(600);

    await service.updateGeneral({ swarm: { cooldownBaseMin: 10, cooldownCeilingHours: 2 } });
    general = (await service.getGeneral()) as Record<string, unknown>;
    expect(general.swarm).toEqual({ cooldownBaseMin: 10, cooldownCeilingHours: 2 });
    expect((general.swarmClaim as Record<string, unknown>).leaseTtlSec).toBe(600);
  });
});
