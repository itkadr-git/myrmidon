import { describe, expect, it } from "vitest";
import {
  CODE_ROLES,
  DEFAULT_CODE_NO_PROGRESS_LIMIT,
  DEFAULT_CODE_REPEATED_TOOL_CALL_LIMIT,
  DEFAULT_NO_PROGRESS_LIMIT,
  DEFAULT_REPEATED_TOOL_CALL_LIMIT,
  RUN_GUARD_STOP_REASONS,
  RunGuard,
  isCodeRole,
  isRunGuardStopReason,
  resolveRunGuardOptions,
} from "./run-guard.js";

describe("RunGuard no-progress exploration stop", () => {
  it("stops at the 40th consecutive read-only call and not before", () => {
    const guard = new RunGuard();
    for (let call = 1; call < DEFAULT_NO_PROGRESS_LIMIT; call += 1) {
      expect(guard.toolStarted(call % 2 ? "search_files" : "read_file", `path-${call}`)).toEqual({ stop: false });
    }
    expect(guard.toolStarted("read_file", "path-last")).toEqual({ stop: true, reason: "no_progress_exploration" });
    expect(guard.stopped).toBe(true);
    expect(guard.stopReason).toBe("no_progress_exploration");
    expect(guard.stats().readOnlyStreak).toBe(DEFAULT_NO_PROGRESS_LIMIT);
    // A stopped guard keeps answering with the first reason.
    expect(guard.toolStarted("patch", "x")).toEqual({ stop: true, reason: "no_progress_exploration" });
  });

  it("counts read-only terminal commands and skill reads in the same streak", () => {
    const guard = new RunGuard({ noProgressLimit: 4, repeatedToolCallLimit: 0 });
    expect(guard.toolStarted("terminal", "sed -n '1,10p' a.ts").stop).toBe(false);
    expect(guard.toolStarted("terminal", "grep -rn foo src | head").stop).toBe(false);
    expect(guard.toolStarted("skill_view", "release").stop).toBe(false);
    expect(guard.toolStarted("terminal", "git log --oneline -5")).toEqual({
      stop: true,
      reason: "no_progress_exploration",
    });
  });

  it("resets the streak on a write: patch, write_file, terminal git commit, curl PATCH", () => {
    const writes: Array<[string, unknown]> = [
      ["patch", "a.ts"],
      ["write_file", "a.ts"],
      ["terminal", "git commit -m x"],
      ["terminal", "gh pr create --title x"],
      ["terminal", "curl -X PATCH http://example.com/api/issues/1 -d '{}'"],
    ];
    for (const [name, args] of writes) {
      const guard = new RunGuard({ noProgressLimit: 5, repeatedToolCallLimit: 0 });
      for (let call = 0; call < 4; call += 1) expect(guard.toolStarted("read_file", `before-${call}`).stop).toBe(false);
      expect(guard.toolStarted(name, args).stop).toBe(false);
      expect(guard.stats().readOnlyStreak).toBe(0);
      // Another four reads after the write do not stop the run: the streak started over.
      for (let call = 0; call < 4; call += 1) expect(guard.toolStarted("read_file", `after-${call}`).stop).toBe(false);
      expect(guard.toolStarted("read_file", "after-last")).toEqual({ stop: true, reason: "no_progress_exploration" });
    }
  });

  it("can be switched off with 0", () => {
    const guard = new RunGuard({ noProgressLimit: 0, repeatedToolCallLimit: 0 });
    for (let call = 0; call < 200; call += 1) expect(guard.toolStarted("read_file", `path-${call}`).stop).toBe(false);
  });
});

describe("RunGuard repeated tool call stop", () => {
  it("stops the 3rd time the same tool and argument are seen", () => {
    const guard = new RunGuard();
    expect(guard.toolStarted("read_file", "src/a.ts").stop).toBe(false);
    expect(guard.toolStarted("search_files", "needle").stop).toBe(false);
    expect(guard.toolStarted("read_file", "src/a.ts").stop).toBe(false);
    expect(guard.toolStarted("read_file", "src/a.ts")).toEqual({
      stop: false, hint: { reason: "repeated_tool_call", tool: "read_file", repeatCount: 3 },
    });
    expect(guard.stopped).toBe(false);
    expect(guard.toolStarted("read_file", "src/a.ts")).toEqual({ stop: true, reason: "repeated_tool_call" });
    expect(DEFAULT_REPEATED_TOOL_CALL_LIMIT).toBe(3);
  });

  it("stops on three identical read_file previews with a line range", () => {
    const guard = new RunGuard();
    expect(guard.toolStarted("read_file", "settings.ts L80-199").stop).toBe(false);
    expect(guard.toolStarted("read_file", "settings.ts L80-199").stop).toBe(false);
    expect(guard.toolStarted("read_file", "settings.ts L80-199")).toEqual({
      stop: false, hint: { reason: "repeated_tool_call", tool: "read_file", repeatCount: 3 },
    });
    expect(guard.toolStarted("read_file", "settings.ts L80-199")).toEqual({ stop: true, reason: "repeated_tool_call" });
    // Another line range of the same file is a different call.
    const other = new RunGuard();
    for (const range of ["L1-79", "L80-199", "L200-299", "L300-399"]) {
      expect(other.toolStarted("read_file", `settings.ts ${range}`).stop).toBe(false);
    }
  });

  it("never counts a call with an empty or whitespace preview as a repeat, but still as read-only progress", () => {
    for (const empty of ["", "   ", "\n\t", undefined, null]) {
      const guard = new RunGuard();
      for (let call = 0; call < 10; call += 1) expect(guard.toolStarted("read_file", empty).stop).toBe(false);
      expect(guard.stopped).toBe(false);
      expect(guard.stats().readOnlyStreak).toBe(10);
    }
    // Empty previews still count toward the no-progress streak.
    const streak = new RunGuard({ noProgressLimit: 4 });
    for (let call = 0; call < 3; call += 1) expect(streak.toolStarted("read_file", "").stop).toBe(false);
    expect(streak.toolStarted("read_file", "")).toEqual({ stop: true, reason: "no_progress_exploration" });
    // An empty preview does not hide a real repeat next to it.
    const mixed = new RunGuard();
    expect(mixed.toolStarted("read_file", "").stop).toBe(false);
    expect(mixed.toolStarted("read_file", "a.ts L1-9").stop).toBe(false);
    expect(mixed.toolStarted("read_file", "").stop).toBe(false);
    expect(mixed.toolStarted("read_file", "a.ts L1-9").stop).toBe(false);
    expect(mixed.toolStarted("read_file", "a.ts L1-9")).toEqual({
      stop: false, hint: { reason: "repeated_tool_call", tool: "read_file", repeatCount: 3 },
    });
    expect(mixed.toolStarted("read_file", "a.ts L1-9")).toEqual({ stop: true, reason: "repeated_tool_call" });
  });

  it("keeps the tool name in the hash: the same preview under another tool is another call", () => {
    const guard = new RunGuard();
    for (let call = 0; call < 2; call += 1) {
      expect(guard.toolStarted("read_file", "settings.ts").stop).toBe(false);
      expect(guard.toolStarted("search_files", "settings.ts").stop).toBe(false);
    }
    expect(guard.stopped).toBe(false);
  });

  it("treats the same argument under another tool, or another argument, as a different call", () => {
    const guard = new RunGuard();
    for (let round = 0; round < 2; round += 1) {
      expect(guard.toolStarted("read_file", "x").stop).toBe(false);
      expect(guard.toolStarted("search_files", "x").stop).toBe(false);
      expect(guard.toolStarted("terminal", "ls x").stop).toBe(false);
    }
    expect(guard.stopped).toBe(false);
  });

  it("compares structured arguments by content, not by key order", () => {
    const guard = new RunGuard({ repeatedToolCallLimit: 2 });
    expect(guard.toolStarted("read_file", { path: "a", offset: 1 }).stop).toBe(false);
    expect(guard.toolStarted("read_file", { offset: 1, path: "a" })).toEqual({
      stop: false, hint: { reason: "repeated_tool_call", tool: "read_file", repeatCount: 2 },
    });
    expect(guard.toolStarted("read_file", { offset: 1, path: "a" })).toEqual({ stop: true, reason: "repeated_tool_call" });
  });

  it("starts counting again after a write (the same read after a change is not a repeat)", () => {
    const guard = new RunGuard();
    expect(guard.toolStarted("read_file", "a.ts").stop).toBe(false);
    expect(guard.toolStarted("read_file", "a.ts").stop).toBe(false);
    expect(guard.toolStarted("patch", "a.ts").stop).toBe(false);
    expect(guard.toolStarted("read_file", "a.ts").stop).toBe(false);
    expect(guard.toolStarted("read_file", "a.ts").stop).toBe(false);
    expect(guard.toolStarted("read_file", "a.ts")).toEqual({
      stop: false, hint: { reason: "repeated_tool_call", tool: "read_file", repeatCount: 3 },
    });
    expect(guard.toolStarted("read_file", "a.ts")).toEqual({ stop: true, reason: "repeated_tool_call" });
  });

  it("does not count writes or unknown terminal commands as repeats", () => {
    const guard = new RunGuard();
    for (let call = 0; call < 10; call += 1) {
      expect(guard.toolStarted("terminal", "pnpm test").stop).toBe(false);
      expect(guard.toolStarted("patch", "same.ts").stop).toBe(false);
    }
  });

  it("can be switched off with 0", () => {
    const guard = new RunGuard({ repeatedToolCallLimit: 0, noProgressLimit: 0 });
    for (let call = 0; call < 50; call += 1) expect(guard.toolStarted("read_file", "same").stop).toBe(false);
  });

  it("keeps only hashes: the stats carry counters, never arguments", () => {
    const guard = new RunGuard();
    guard.toolStarted("terminal", "grep -rn do-not-log src");
    expect(JSON.stringify(guard.stats())).not.toContain("do-not-log");
    expect(guard.stats()).toMatchObject({ toolCalls: 1, readOnlyStreak: 1 });
  });

  it("hints once per reason even when a different read repeats after a write", () => {
    const guard = new RunGuard({ repeatedToolCallLimit: 2, noProgressLimit: 0 });
    guard.toolStarted("read_file", "first");
    expect(guard.toolStarted("read_file", "first")).toEqual({
      stop: false, hint: { reason: "repeated_tool_call", tool: "read_file", repeatCount: 2 },
    });
    expect(guard.toolStarted("patch", "changed")).toEqual({ stop: false });
    expect(guard.toolStarted("search_files", "second")).toEqual({ stop: false });
    expect(guard.toolStarted("search_files", "second")).toEqual({ stop: true, reason: "repeated_tool_call" });
  });

  it("does not include raw arguments in the hint", () => {
    const guard = new RunGuard({ repeatedToolCallLimit: 1 });
    const decision = guard.toolStarted("read_file", "private-path");
    expect(decision.hint).toEqual({ reason: "repeated_tool_call", tool: "read_file", repeatCount: 1 });
    expect(JSON.stringify(decision)).not.toContain("private-path");
  });
});

// myrmidon(RUN-GUARD-CONTINUE): the guard counts the calls that change something, so the board can
// tell a call-limit stop of a run that was working from one that only looked around.
describe("RunGuard write calls", () => {
  it("counts every call the classifier does not take for read-only, over the whole run", () => {
    const guard = new RunGuard({ noProgressLimit: 0, repeatedToolCallLimit: 0 });
    guard.toolStarted("read_file", "a.ts L1-40");
    guard.toolStarted("patch", "a.ts");
    guard.toolStarted("write_file", "b.ts");
    guard.toolStarted("terminal", "git commit -m x");
    guard.toolStarted("terminal", "grep -rn foo src | head");
    guard.toolStarted("search_files", "foo");
    // The read-only streak starts over at every write; the write counter only grows.
    expect(guard.stats()).toMatchObject({ toolCalls: 6, writeCalls: 3, readOnlyStreak: 2 });
    guard.toolStarted("patch", "c.ts");
    expect(guard.stats()).toMatchObject({ toolCalls: 7, writeCalls: 4, readOnlyStreak: 0 });
  });

  it("counts terminal commands that write and tools it does not know as writes", () => {
    const guard = new RunGuard({ noProgressLimit: 0, repeatedToolCallLimit: 0 });
    guard.toolStarted("terminal", "pnpm test");
    guard.toolStarted("terminal", "echo x > out.txt");
    guard.toolStarted("terminal", "sed -i s/a/b/ f.ts");
    guard.toolStarted("some_new_tool", "x");
    expect(guard.stats().writeCalls).toBe(4);
  });

  it("stays 0 for a run that only read", () => {
    const guard = new RunGuard({ noProgressLimit: 0, repeatedToolCallLimit: 0 });
    guard.toolStarted("read_file", "a.ts");
    guard.toolStarted("terminal", "ls -la src");
    guard.toolStarted("terminal", "git log --oneline -5");
    expect(guard.stats()).toMatchObject({ toolCalls: 3, writeCalls: 0, readOnlyStreak: 3 });
  });

  it("is in the statistics of a run stopped at the model call limit", () => {
    const guard = new RunGuard({ modelCallLimit: 3, noProgressLimit: 0, repeatedToolCallLimit: 0 });
    expect(guard.modelCall()).toEqual({ stop: false });
    guard.toolStarted("patch", "a.ts");
    expect(guard.modelCall()).toEqual({ stop: false });
    guard.toolStarted("read_file", "a.ts");
    expect(guard.modelCall()).toEqual({ stop: false });
    expect(guard.modelCall()).toEqual({ stop: true, reason: "model_call_limit" });
    expect(guard.stats()).toMatchObject({ modelCalls: 3, toolCalls: 2, writeCalls: 1 });
  });

  it("does not count calls after the guard stopped, and keeps no arguments", () => {
    const guard = new RunGuard({ noProgressLimit: 2, repeatedToolCallLimit: 0 });
    guard.toolStarted("write_file", "secret-name.ts");
    guard.toolStarted("read_file", "a");
    expect(guard.toolStarted("read_file", "b")).toEqual({ stop: true, reason: "no_progress_exploration" });
    guard.toolStarted("patch", "late");
    expect(guard.stats().writeCalls).toBe(1);
    expect(JSON.stringify(guard.stats())).not.toContain("secret-name");
  });

  it("hints on the first model call limit without writes, then stops on the next attempt", () => {
    const guard = new RunGuard({ modelCallLimit: 2 });
    expect(guard.modelCall()).toEqual({ stop: false });
    expect(guard.modelCall()).toEqual({ stop: false });
    expect(guard.modelCall()).toEqual({ stop: false, hint: { reason: "model_call_limit", modelCalls: 2 } });
    expect(guard.stopped).toBe(false);
    expect(guard.event()).toEqual({ stop: false });
    expect(guard.modelCall()).toEqual({ stop: true, reason: "model_call_limit" });
    expect(guard.modelCall()).toEqual({ stop: true, reason: "model_call_limit" });
    expect(guard.stats().modelCalls).toBe(2);
  });

  it("does not hint at the model call limit after any write", () => {
    const guard = new RunGuard({ modelCallLimit: 1 });
    expect(guard.modelCall()).toEqual({ stop: false });
    expect(guard.toolStarted("patch", "a.ts")).toEqual({ stop: false });
    expect(guard.modelCall()).toEqual({ stop: true, reason: "model_call_limit" });
  });

  it("leaves retry loops and idle timeouts as immediate stops", () => {
    const retry = new RunGuard({ toolRetryLimit: 1 });
    expect(retry.toolFailure("read_file", "x")).toEqual({ stop: true, reason: "tool_retry_loop" });
    let now = 0;
    const idle = new RunGuard({ now: () => now, idleTimeoutMs: 5 });
    now = 5;
    expect(idle.idle()).toEqual({ stop: true, reason: "idle_timeout" });
  });

  it("does not hint again when model call limit is reached after a repeat hint", () => {
    const guard = new RunGuard({ modelCallLimit: 1, repeatedToolCallLimit: 1 });
    expect(guard.modelCall()).toEqual({ stop: false });
    expect(guard.toolStarted("read_file", "x")).toEqual({
      stop: false, hint: { reason: "repeated_tool_call", tool: "read_file", repeatCount: 1 },
    });
    expect(guard.modelCall()).toEqual({ stop: false, hint: { reason: "model_call_limit", modelCalls: 1 } });
    expect(guard.modelCall()).toEqual({ stop: true, reason: "model_call_limit" });
  });
});

// myrmidon(OPE-12799): engineers ran everything through execute_code (run 7cb1b9a2:
// 151 calls of 151). The guard took each for a write, so the no-progress stop never
// tripped, the run burned the whole call limit, and the board took the stop for
// productive work and repeated it.
describe("RunGuard opaque calls (execute_code) are not confirmed writes", () => {
  it("stops a run that only calls execute_code at the no-progress limit, long before the call limit", () => {
    const guard = new RunGuard({ role: "engineer" });
    const preview = "import subprocess def sh(cmd, cwd=";
    for (let call = 1; call < DEFAULT_CODE_NO_PROGRESS_LIMIT; call += 1) {
      expect(guard.modelCall().stop).toBe(false);
      expect(guard.toolStarted("execute_code", preview)).toEqual({ stop: false });
    }
    expect(guard.modelCall().stop).toBe(false);
    expect(guard.toolStarted("execute_code", preview)).toEqual({ stop: true, reason: "no_progress_exploration" });
    expect(guard.stats()).toMatchObject({
      modelCalls: DEFAULT_CODE_NO_PROGRESS_LIMIT,
      writeCalls: 0,
      opaqueCalls: DEFAULT_CODE_NO_PROGRESS_LIMIT,
      readOnlyStreak: DEFAULT_CODE_NO_PROGRESS_LIMIT,
    });
  });

  it("does not let execute_code reset the streak of reads", () => {
    const guard = new RunGuard({ noProgressLimit: 5, repeatedToolCallLimit: 0 });
    for (let call = 0; call < 3; call += 1) expect(guard.toolStarted("read_file", `before-${call}`).stop).toBe(false);
    expect(guard.toolStarted("execute_code", "print(1)").stop).toBe(false);
    expect(guard.stats()).toMatchObject({ readOnlyStreak: 4, writeCalls: 0, opaqueCalls: 1 });
    expect(guard.toolStarted("read_file", "after")).toEqual({ stop: true, reason: "no_progress_exploration" });
  });

  it("still starts the streak over at a confirmed write between execute_code calls", () => {
    const guard = new RunGuard({ noProgressLimit: 5, repeatedToolCallLimit: 0 });
    for (let round = 0; round < 10; round += 1) {
      for (let call = 0; call < 4; call += 1) expect(guard.toolStarted("execute_code", "print(1)").stop).toBe(false);
      expect(guard.toolStarted("patch", "a.ts").stop).toBe(false);
    }
    expect(guard.stats()).toMatchObject({ writeCalls: 10, opaqueCalls: 40, readOnlyStreak: 0 });
  });

  it("never takes the same execute_code preview for a repeated call", () => {
    const guard = new RunGuard({ noProgressLimit: 0, repeatedToolCallLimit: 2 });
    for (let call = 0; call < 20; call += 1) {
      expect(guard.toolStarted("execute_code", "import subprocess def sh(cmd, cwd=")).toEqual({ stop: false });
    }
  });
});

// myrmidon(OPE-12799): the stop at the call limit lost the work of the run: nothing
// told the agent the limit was near, and the next run starts in a fresh session.
describe("RunGuard wrap-up hint before the model call limit", () => {
  it("hints once, 15 calls before the limit, after writes as well, and stops at the limit as before", () => {
    const guard = new RunGuard({ modelCallLimit: 150, noProgressLimit: 0, repeatedToolCallLimit: 0 });
    for (let call = 1; call < 135; call += 1) {
      expect(guard.modelCall()).toEqual({ stop: false });
      guard.toolStarted("patch", `file-${call}.ts`);
    }
    expect(guard.modelCall()).toEqual({
      stop: false,
      hint: { reason: "model_call_limit", modelCalls: 135, remaining: 15 },
    });
    for (let call = 136; call <= 150; call += 1) expect(guard.modelCall()).toEqual({ stop: false });
    expect(guard.modelCall()).toEqual({ stop: true, reason: "model_call_limit" });
    expect(guard.stats().modelCalls).toBe(150);
  });

  it("is not given for a limit below 100 calls", () => {
    const guard = new RunGuard({ modelCallLimit: 50, noProgressLimit: 0, repeatedToolCallLimit: 0 });
    for (let call = 1; call <= 50; call += 1) {
      expect(guard.modelCall()).toEqual({ stop: false });
      guard.toolStarted("patch", `file-${call}.ts`);
    }
    expect(guard.modelCall()).toEqual({ stop: true, reason: "model_call_limit" });
  });
});

describe("RunGuard configuration", () => {
  it("defaults to 40 consecutive read-only calls and 3 repeats", () => {
    const options = resolveRunGuardOptions({ env: {} });
    expect(options.noProgressLimit).toBe(40);
    expect(options.repeatedToolCallLimit).toBe(3);
    expect(DEFAULT_NO_PROGRESS_LIMIT).toBe(40);
  });

  it("defaults to 100 consecutive read-only calls and 5 repeats for code roles", () => {
    for (const role of ["engineer", "reviewer", "lead", "architect", " ENGINEER ", "Architect"]) {
      expect(isCodeRole(role)).toBe(true);
      const options = resolveRunGuardOptions({ role, env: {} });
      expect(options.noProgressLimit).toBe(100);
      expect(options.repeatedToolCallLimit).toBe(5);
      const agentOptions = resolveRunGuardOptions({ agentConfig: { role }, env: {} });
      expect(agentOptions.noProgressLimit).toBe(100);
      expect(agentOptions.repeatedToolCallLimit).toBe(5);
    }
    for (const nonCode of ["cmo", "pm", "qa", "general", "ceo", "designer"]) {
      expect(isCodeRole(nonCode)).toBe(false);
      const options = resolveRunGuardOptions({ role: nonCode, env: {} });
      expect(options.noProgressLimit).toBe(40);
      expect(options.repeatedToolCallLimit).toBe(3);
    }
    expect(DEFAULT_CODE_NO_PROGRESS_LIMIT).toBe(100);
    expect(DEFAULT_CODE_REPEATED_TOOL_CALL_LIMIT).toBe(5);
  });

  it("engineer run with 80 distinct reads without write does not stop; 5 identical reads without write stops", () => {
    const guard = new RunGuard({ role: "engineer" });
    for (let i = 1; i <= 80; i += 1) {
      expect(guard.toolStarted("read_file", `src/file-${i}.ts`)).toEqual({ stop: false });
    }
    expect(guard.stopped).toBe(false);
    expect(guard.stats().readOnlyStreak).toBe(80);

    const repeatGuard = new RunGuard({ role: "engineer" });
    for (let i = 1; i < 5; i += 1) {
      expect(repeatGuard.toolStarted("read_file", "src/file.ts")).toEqual({ stop: false });
    }
    expect(repeatGuard.toolStarted("read_file", "src/file.ts")).toEqual({
      stop: false,
      hint: { reason: "repeated_tool_call", tool: "read_file", repeatCount: 5 },
    });
    expect(repeatGuard.stopped).toBe(false);
    expect(repeatGuard.toolStarted("read_file", "src/file.ts")).toEqual({
      stop: true,
      reason: "repeated_tool_call",
    });
  });

  it("takes the limits from the agent card, the team settings and the environment, in that order", () => {
    expect(
      resolveRunGuardOptions({
        env: { MYRMIDON_RUN_GUARD_NO_PROGRESS_LIMIT: "30", MYRMIDON_RUN_GUARD_REPEATED_TOOL_CALL_LIMIT: "6" },
      }),
    ).toMatchObject({ noProgressLimit: 30, repeatedToolCallLimit: 6 });
    expect(
      resolveRunGuardOptions({
        teamLiveness: { runGuard: { noProgressLimit: 25, repeatedToolCallLimit: 5 } },
        env: { MYRMIDON_RUN_GUARD_NO_PROGRESS_LIMIT: "30" },
      }),
    ).toMatchObject({ noProgressLimit: 25, repeatedToolCallLimit: 5 });
    expect(
      resolveRunGuardOptions({
        agentConfig: { runGuard: { noProgressLimit: 12, repeatedToolCallLimit: 4 } },
        teamLiveness: { runGuard: { noProgressLimit: 25, repeatedToolCallLimit: 5 } },
      }),
    ).toMatchObject({ noProgressLimit: 12, repeatedToolCallLimit: 4 });
  });

  it("accepts an explicit 0 as 'off' and ignores junk", () => {
    expect(
      resolveRunGuardOptions({ agentConfig: { runGuard: { noProgressLimit: 0, repeatedToolCallLimit: "0" } } }),
    ).toMatchObject({ noProgressLimit: 0, repeatedToolCallLimit: 0 });
    expect(
      resolveRunGuardOptions({ env: { MYRMIDON_RUN_GUARD_NO_PROGRESS_LIMIT: "-3", MYRMIDON_RUN_GUARD_REPEATED_TOOL_CALL_LIMIT: "abc" } }),
    ).toMatchObject({ noProgressLimit: 40, repeatedToolCallLimit: 3 });
  });

  it("uses the resolved limits", () => {
    const guard = new RunGuard(resolveRunGuardOptions({ env: { MYRMIDON_RUN_GUARD_NO_PROGRESS_LIMIT: "3" } }));
    expect(guard.toolStarted("read_file", "a").stop).toBe(false);
    expect(guard.toolStarted("read_file", "b").stop).toBe(false);
    expect(guard.toolStarted("read_file", "c")).toEqual({ stop: true, reason: "no_progress_exploration" });
  });
});

describe("run guard stop reasons", () => {
  it("lists the old reasons and the two new ones", () => {
    expect([...RUN_GUARD_STOP_REASONS]).toEqual([
      "model_call_limit",
      "idle_timeout",
      "tool_retry_loop",
      "no_progress_exploration",
      "repeated_tool_call",
    ]);
    expect(isRunGuardStopReason("no_progress_exploration")).toBe(true);
    expect(isRunGuardStopReason("repeated_tool_call")).toBe(true);
    expect(isRunGuardStopReason("hermes_gateway_connect_failed")).toBe(false);
    expect(isRunGuardStopReason("myrmidon_maintenance_interrupted")).toBe(false);
    expect(isRunGuardStopReason(null)).toBe(false);
  });
});
