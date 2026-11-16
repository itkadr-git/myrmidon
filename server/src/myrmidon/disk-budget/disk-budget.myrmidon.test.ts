import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DISK_BUDGET_GC_COOLDOWN_MS,
  DISK_BUDGET_GC_FAILURE_COOLDOWN_MS,
  createDiskBudgetGate,
  createHostGcRequestFileWriter,
  diskBudgetDueAt,
  freePercentOf,
  resolveDiskBudgetMinFreePercent,
} from "./disk-budget.js";

const TOTAL = 1000;
const vol = (free: number) => async () => ({ freeBytes: free, totalBytes: TOTAL });

function gateWith(free: () => number, requestGc: (i: { freePercent: number; at: Date }) => Promise<boolean>, clock = { t: 1_000_000 }) {
  return {
    clock,
    gate: createDiskBudgetGate({
      measure: async () => ({ freeBytes: free(), totalBytes: TOTAL }),
      requestGc,
      now: () => new Date(clock.t),
    }),
  };
}

describe("disk budget gate (OPE-13419)", () => {
  it("blocks at 4.9% free and lets the run through at 5% free", async () => {
    let free = 49;
    let calls = 0;
    const { gate } = gateWith(() => free, async () => { calls += 1; return true; });
    expect(await gate.check()).toMatchObject({ blocked: true, minFreePercent: 5, gc: "requested" });
    free = 50; // exactly 5%
    expect(await gate.check()).toEqual({ blocked: false });
    free = 49;
    expect((await gate.check()).blocked).toBe(true);
    expect(calls).toBe(1);
  });

  it("the minimum is configurable (MYRMIDON_DISK_BUDGET_MIN_FREE_PERCENT); a bad value falls back to 5", async () => {
    expect(resolveDiskBudgetMinFreePercent({})).toBe(5);
    expect(resolveDiskBudgetMinFreePercent({ MYRMIDON_DISK_BUDGET_MIN_FREE_PERCENT: "8" })).toBe(8);
    for (const bad of ["", "abc", "0", "-3", "75"]) {
      expect(resolveDiskBudgetMinFreePercent({ MYRMIDON_DISK_BUDGET_MIN_FREE_PERCENT: bad })).toBe(5);
    }
    const gate = createDiskBudgetGate({ measure: vol(70), requestGc: async () => true, minFreePercent: 8 });
    expect(await gate.check()).toMatchObject({ blocked: true, minFreePercent: 8 });
  });

  it("does not block when the volume cannot be measured", async () => {
    const gate = createDiskBudgetGate({ measure: async () => null, requestGc: async () => true });
    expect(await gate.check()).toEqual({ blocked: false });
    const throwing = createDiskBudgetGate({ measure: async () => { throw new Error("gate down"); }, requestGc: async () => true });
    expect(await throwing.check()).toEqual({ blocked: false });
    expect(freePercentOf({ freeBytes: 5, totalBytes: 0 })).toBeNull();
    expect(freePercentOf({ freeBytes: -1, totalBytes: 10 })).toBeNull();
  });

  it("parallel checks ask host GC once (single flight), then the cooldown holds", async () => {
    let calls = 0;
    let release: (ok: boolean) => void = () => undefined;
    const { gate, clock } = gateWith(() => 30, () => { calls += 1; if (calls > 1) return Promise.resolve(true); return new Promise<boolean>((r) => { release = r; }); });
    const all = Promise.all([gate.check(), gate.check(), gate.check()]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release(true);
    const verdicts = await all;
    expect(calls).toBe(1);
    expect(verdicts.map((v) => (v.blocked ? v.gc : "pass")).sort()).toEqual(["in_flight", "in_flight", "requested"]);
    clock.t += DISK_BUDGET_GC_COOLDOWN_MS - 1;
    expect(await gate.check()).toMatchObject({ blocked: true, gc: "cooldown" });
    clock.t += 1;
    expect(await gate.check()).toMatchObject({ blocked: true, gc: "requested" });
    expect(calls).toBe(2);
  });

  it("a failed cleanup request still defers the run and is retried after the short cooldown", async () => {
    let calls = 0;
    const { gate, clock } = gateWith(() => 30, async () => { calls += 1; throw new Error("no channel"); });
    expect(await gate.check()).toMatchObject({ blocked: true, gc: "failed" });
    expect(await gate.check()).toMatchObject({ blocked: true, gc: "cooldown" });
    clock.t += DISK_BUDGET_GC_FAILURE_COOLDOWN_MS;
    expect(await gate.check()).toMatchObject({ blocked: true, gc: "failed" });
    expect(calls).toBe(2);
  });

  it("without a request channel the run is deferred and nothing is asked", async () => {
    let calls = 0;
    const gate = createDiskBudgetGate({ measure: vol(10), requestGc: async () => { calls += 1; return true; }, gcConfigured: false });
    expect(await gate.check()).toMatchObject({ blocked: true, gc: "unconfigured" });
    expect(calls).toBe(0);
  });

  it("recheck ladder is 1, 2, 5 minutes and stays at 5", () => {
    const now = new Date(0);
    expect([0, 1, 2, 9].map((n) => diskBudgetDueAt(now, n).getTime() / 60_000)).toEqual([1, 2, 5, 5]);
  });

  it("the request file is written atomically and a missing directory reports failure", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "disk-budget-"));
    try {
      const file = path.join(dir, "gc-request.json");
      const write = createHostGcRequestFileWriter(file);
      expect(await write({ freePercent: 9.04, at: new Date(0) })).toBe(true);
      expect(JSON.parse(await fs.readFile(file, "utf8"))).toMatchObject({ reason: "disk_budget", freePercent: 9 });
      expect((await fs.readdir(dir)).sort()).toEqual(["gc-request.json"]);
      expect(await createHostGcRequestFileWriter(path.join(dir, "no", "such", "file"))({ freePercent: 1, at: new Date(0) })).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
