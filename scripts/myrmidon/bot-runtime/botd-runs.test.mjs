import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(1.6.5 BOT-DISK-H3f): the "is a run going" probe of botd. A fake /proc and a fake clock.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const { createRunProbe, RUN_WINDOW_MS } = await import(path.join(ROOT, "docker/bot-runtime/botd/lib/runs.js"));

function rig(procs) {
  let t = 1_000_000;
  const proc = new EventEmitter();
  const fsImpl = {
    readdirSync: (dir) => {
      if (procs === null) throw new Error("ENOENT");
      return ["self", ...Object.keys(procs)];
    },
    readlinkSync: (p) => {
      const pid = p.split("/").slice(-2)[0];
      if (!(pid in procs)) throw new Error("ENOENT");
      return procs[pid];
    },
  };
  const probe = createRunProbe({ proc, now: () => t, fsImpl, procRoot: "/proc" });
  return { probe, proc, advance: (ms) => (t += ms), procs };
}

describe("botd runs: probe", () => {
  it("just started with nothing seen: unknown", () => {
    assert.equal(rig({ 10: "/" }).probe.probe().live, null);
  });

  it("a process with cwd under /scratch or /workspace: live", () => {
    assert.equal(rig({ 10: "/scratch/repo/src" }).probe.probe().live, true);
    assert.equal(rig({ 10: "/workspace/OPE-1" }).probe.probe().live, true);
    assert.equal(rig({ 10: "/scratchy" }).probe.probe().live, null);
  });

  it("SIGUSR1 makes it live for the window, then idle once the window passed", () => {
    const r = rig({ 10: "/" });
    r.advance(RUN_WINDOW_MS + 1);
    assert.equal(r.probe.probe().live, false);
    r.proc.emit("SIGUSR1");
    assert.equal(r.probe.probe().live, true);
    r.advance(RUN_WINDOW_MS - 1);
    assert.equal(r.probe.probe().live, true);
    r.advance(2);
    assert.equal(r.probe.probe().live, false);
  });

  it("a wake-up soon after start does not make an early idle verdict", () => {
    const r = rig({ 10: "/" });
    r.proc.emit("SIGUSR1");
    r.advance(RUN_WINDOW_MS + 1);
    assert.equal(r.probe.probe().live, false);
  });

  it("unreadable /proc after the window: unknown, not idle", () => {
    const r = rig(null);
    r.advance(RUN_WINDOW_MS + 1);
    assert.equal(r.probe.probe().live, null);
    const empty = rig({});
    empty.advance(RUN_WINDOW_MS + 1);
    assert.equal(empty.probe.probe().live, null);
  });
});
