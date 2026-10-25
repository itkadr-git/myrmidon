import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(MYR-WS-RECOVER): botd repairs copies an interrupted run left half-way, but only
// when no run is going (or may be going). The git work is `myr-ws repair`
// (myr-ws-recover.test.mjs); this pins WHEN botd calls it and that a failure never breaks a pass.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const { repairInterrupted } = await import(path.join(ROOT, "docker/bot-runtime/botd/lib/repair.js"));

function rig({ live, res, fail }) {
  const calls = [];
  const lines = [];
  return {
    calls,
    lines,
    deps: {
      ws: async (args) => {
        calls.push(args);
        if (fail) throw new Error(fail);
        return res;
      },
      runProbe: { probe: () => ({ live }) },
      log: (l) => lines.push(l),
    },
  };
}

describe("botd repair sweep", () => {
  it("calls `myr-ws repair` when no run is going and logs what was repaired", async () => {
    const r = rig({
      live: false,
      res: { repaired: [{ key: "OPE-6975", recovered: [{ problem: "merge_in_progress", action: "aborted" }], recoveryRef: "refs/myr-ws/recovery/OPE-6975" }], skipped: [], errors: [] },
    });
    const out = await repairInterrupted(r.deps);
    assert.deepEqual(r.calls, [["repair"]]);
    assert.deepEqual(out, { ran: true, repaired: 1 });
    assert.match(r.lines[0], /OPE-6975.*merge_in_progress:aborted.*refs\/myr-ws\/recovery\/OPE-6975/);
  });

  it("does not touch copies while a run is going or when that is unknown", async () => {
    for (const live of [true, null, undefined]) {
      const r = rig({ live, res: { repaired: [] } });
      assert.deepEqual(await repairInterrupted(r.deps), { ran: false, repaired: 0 });
      assert.equal(r.calls.length, 0);
    }
  });

  it("a failing repair is logged and does not throw; per-copy errors are logged", async () => {
    const failing = rig({ live: false, fail: "myr-ws repair exit 1: boom" });
    assert.deepEqual(await repairInterrupted(failing.deps), { ran: true, repaired: 0 });
    assert.match(failing.lines[0], /repair failed.*boom/);
    const partial = rig({ live: false, res: { repaired: [], errors: [{ key: "OPE-1", error: "stuck" }] } });
    await repairInterrupted(partial.deps);
    assert.match(partial.lines[0], /repair of OPE-1 failed: stuck/);
  });

  it("a throwing probe means no repair", async () => {
    const r = rig({ live: false, res: {} });
    r.deps.runProbe = { probe: () => { throw new Error("x"); } };
    assert.deepEqual(await repairInterrupted(r.deps), { ran: false, repaired: 0 });
  });

  it("botd wires the sweep into its pass before the inventory", () => {
    const src = fs.readFileSync(path.join(ROOT, "docker/bot-runtime/botd/botd"), "utf8");
    assert.match(src, /repairMod\.repairInterrupted\(\{ ws, runProbe, log \}\)/);
    assert.ok(src.indexOf("repairInterrupted") < src.indexOf('(await ws(["list"]))'));
  });
});
