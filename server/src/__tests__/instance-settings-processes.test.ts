// myrmidon(1.6.6 PROCS-1.7 part A): `general.processes` must roundtrip through
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

  it("accepts out-of-range values on the PATCH path (passthrough); the lease manager clamps them defensively", () => {
    const parse = (processes: unknown) => patchInstanceGeneralSettingsSchema.safeParse({ processes }).success;
    expect(parse({ mode: "split", leaderLeaseTtlSec: 45 })).toBe(true);
    // Out-of-range / unknown shapes are stored as-is; the live read in
    // server/src/myrmidon/leader-lease clamps TTL to 5..300 and treats any
    // mode !== "split" as single-process (defaults hold).
    expect(parse({ apiCount: 5 })).toBe(true);
    expect(parse({ mode: "cluster" })).toBe(true);
    expect(parse({ leaderLeaseTtlSec: 4 })).toBe(true);
  });

  it("coexists with the PROCS-J counts in the same key (passthrough)", () => {
    // general.processes carries both halves: PROCS-J owns api/worker, this PR
    // owns mode/leaderLeaseTtlSec/…. Neither schema may refuse the other's
    // fields (design OPE-5394 §7.2: one row for the whole feature).
    const parse = (processes: unknown) => patchInstanceGeneralSettingsSchema.safeParse({ processes }).success;
    expect(parse({ api: 2, worker: 1, mode: "split", leaderLeaseTtlSec: 45 })).toBe(true);
    expect(parse({ api: 1, worker: 0 })).toBe(true);
    expect(parse({ mode: "split" })).toBe(true);
  });
});
