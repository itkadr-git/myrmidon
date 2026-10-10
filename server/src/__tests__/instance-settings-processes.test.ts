// myrmidon(1.6.5 PROCS-0.1): `general.processes` must roundtrip through
// updateGeneral/getGeneral (the normalizeGeneralSettings whitelist drops every
// key it does not list), survive an unrelated write, stay absent until someone
// sets it, and be validated on the PATCH path.
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { patchInstanceGeneralSettingsSchema } from "@paperclipai/shared";
import { instanceSettingsService } from "../services/instance-settings.js";

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
    // No isolation in this stub: the transaction callback gets the same object back.
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    select: () => ({ from: () => ({ where: () => stubRows([row]) }) }),
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

describe("instance settings: general.processes", () => {
  const split = {
    mode: "split",
    apiCount: 2,
    leaderLeaseTtlSec: 45,
    liveEventsBus: "pg",
    admissionStore: "db",
    singletonProxy: false,
  } as const;

  it("PATCH -> GET roundtrips the block", async () => {
    const svc = instanceSettingsService(stubDb({}), { runtimeEnv: {} });
    const updated = await svc.updateGeneral({ processes: split });
    expect(updated.general.processes).toEqual(split);
    expect((await svc.getGeneral()).processes).toEqual(split);
  });

  it("an unrelated general write keeps the stored block", async () => {
    const svc = instanceSettingsService(stubDb({ processes: split }), { runtimeEnv: {} });
    await svc.updateGeneral({ censorUsernameInLogs: true });
    const read = await svc.getGeneral();
    expect(read.censorUsernameInLogs).toBe(true);
    expect(read.processes).toEqual(split);
  });

  it("stays absent when nobody set it, so the board is a single process", async () => {
    const svc = instanceSettingsService(stubDb({}), { runtimeEnv: {} });
    expect(await svc.getGeneral()).not.toHaveProperty("processes");
  });

  it("fills the single-process defaults for an empty block", async () => {
    const svc = instanceSettingsService(stubDb({ processes: {} }), { runtimeEnv: {} });
    expect((await svc.getGeneral()).processes).toEqual({
      mode: "single",
      apiCount: 1,
      leaderLeaseTtlSec: 30,
      liveEventsBus: "local",
      admissionStore: "memory",
      singletonProxy: true,
    });
  });

  it("rejects values outside the ranges on the PATCH path", () => {
    const parse = (processes: unknown) => patchInstanceGeneralSettingsSchema.safeParse({ processes }).success;
    expect(parse({ mode: "split", apiCount: 4 })).toBe(true);
    expect(parse({ apiCount: 5 })).toBe(false);
    expect(parse({ apiCount: 0 })).toBe(false);
    expect(parse({ mode: "cluster" })).toBe(false);
    expect(parse({ leaderLeaseTtlSec: 4 })).toBe(false);
    expect(parse({ liveEventsBus: "redis" })).toBe(false);
  });
});
