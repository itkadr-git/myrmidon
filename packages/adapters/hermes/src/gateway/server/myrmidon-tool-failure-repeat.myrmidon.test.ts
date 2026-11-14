import { describe, expect, it } from "vitest";
import { createToolFailureRepeatTracker } from "./myrmidon-tool-failure-repeat.js";

// myrmidon(OPE-12796): the gateway's tool.completed carries `error` as a boolean
// (errorText null here) or, on some builds, a string.
describe("tool failure repeat tracker (OPE-12796)", () => {
  it("does not stop on three parallel failures of one tool in one model turn", () => {
    const t = createToolFailureRepeatTracker();
    t.started("skill_view", '{"name":"a"}');
    t.started("skill_view", '{"name":"b"}');
    t.started("skill_view", '{"name":"c"}');
    expect(t.completed("skill_view", true, null)).toBeNull();
    expect(t.completed("skill_view", true, null)).toBeNull();
    expect(t.completed("skill_view", true, null)).toBeNull();
  });

  it("does not stop on three parallel failures of the identical call either", () => {
    const t = createToolFailureRepeatTracker();
    for (let i = 0; i < 3; i += 1) t.started("terminal", "gh pr checks 1");
    for (let i = 0; i < 3; i += 1) expect(t.completed("terminal", true, null)).toBeNull();
  });

  it("does not stop on three sequential failures with different arguments", () => {
    const t = createToolFailureRepeatTracker();
    for (const cmd of ["gh pr checks 1", "jq .x f.json", "gh run rerun 9"]) {
      t.started("terminal", cmd);
      expect(t.completed("terminal", true, null)).toBeNull();
    }
  });

  it("stops on the same call failing three times in separate turns (boolean error)", () => {
    const t = createToolFailureRepeatTracker();
    const results = [];
    for (let i = 0; i < 3; i += 1) {
      t.started("terminal", "gh run rerun 9");
      results.push(t.completed("terminal", true, null));
    }
    expect(results[0]).toBeNull();
    expect(results[1]).toBeNull();
    expect(results[2]).toEqual({ count: 3, preview: "gh run rerun 9" });
  });

  it("counts a parallel batch once, then the next turns continue the streak", () => {
    const t = createToolFailureRepeatTracker();
    t.started("terminal", "x");
    t.started("terminal", "x");
    expect(t.completed("terminal", true, null)).toBeNull(); // count 1
    expect(t.completed("terminal", true, null)).toBeNull(); // same turn, ignored
    t.started("terminal", "x");
    expect(t.completed("terminal", true, null)).toBeNull(); // count 2
    t.started("terminal", "x");
    expect(t.completed("terminal", true, null)?.count).toBe(3);
  });

  it("resets the streak after a successful call in between", () => {
    const t = createToolFailureRepeatTracker();
    t.started("terminal", "x");
    t.completed("terminal", true, null);
    t.started("terminal", "x");
    t.completed("terminal", true, null);
    t.started("read_file", "f");
    expect(t.completed("read_file", false, null)).toBeNull();
    t.started("terminal", "x");
    expect(t.completed("terminal", true, null)).toBeNull();
    t.started("terminal", "x");
    expect(t.completed("terminal", true, null)).toBeNull();
  });

  it("with error text: same text repeats, different text restarts the streak", () => {
    const t = createToolFailureRepeatTracker();
    t.started("terminal", "x");
    t.completed("terminal", true, "exit 1");
    t.started("terminal", "x");
    t.completed("terminal", true, "exit 1");
    t.started("terminal", "x");
    expect(t.completed("terminal", true, "exit 2")).toBeNull();
    t.started("terminal", "x");
    expect(t.completed("terminal", true, "exit 2")).toBeNull();
    t.started("terminal", "x");
    expect(t.completed("terminal", true, "exit 2")?.count).toBe(3);
  });

  it("a failure of another tool restarts the streak", () => {
    const t = createToolFailureRepeatTracker();
    t.started("terminal", "x");
    t.completed("terminal", true, null);
    t.started("terminal", "x");
    t.completed("terminal", true, null);
    t.started("skill_view", "s");
    t.completed("skill_view", true, null);
    t.started("terminal", "x");
    expect(t.completed("terminal", true, null)).toBeNull();
  });

  // myrmidon(OPE-12878): the guard steers its one hint and drops the streak, so
  // the stop needs TOOL_FAILURE_REPEAT_LIMIT fresh failures after the hint.
  it("resetStreak drops the current streak; a fresh one builds from zero", () => {
    const t = createToolFailureRepeatTracker();
    t.started("terminal", "x");
    t.completed("terminal", true, null);
    t.started("terminal", "x");
    t.completed("terminal", true, null);
    t.started("terminal", "x");
    expect(t.completed("terminal", true, null)?.count).toBe(3);
    t.resetStreak();
    t.started("terminal", "x");
    expect(t.completed("terminal", true, null)).toBeNull();
    t.started("terminal", "x");
    expect(t.completed("terminal", true, null)).toBeNull();
    t.started("terminal", "x");
    expect(t.completed("terminal", true, null)?.count).toBe(3);
  });
});
