import { describe, expect, it } from "vitest";
import { RunGuard, toolFailureSignature } from "./run-guard.js";

describe("RunGuard", () => {
  it("allows N calls and stops on N+1", () => {
    const guard = new RunGuard({ modelCallLimit: 3 });
    expect(guard.modelCall().stop).toBe(false);
    expect(guard.modelCall().stop).toBe(false);
    expect(guard.modelCall().stop).toBe(false);
    expect(guard.modelCall()).toEqual({ stop: true, reason: "model_call_limit" });
  });

  it("times out at the idle boundary and refreshes on events", () => {
    let now = 100;
    const guard = new RunGuard({ idleTimeoutMs: 20, now: () => now });
    now = 119;
    expect(guard.idle().stop).toBe(false);
    expect(guard.event().stop).toBe(false);
    now = 139;
    expect(guard.idle()).toEqual({ stop: true, reason: "idle_timeout" });
  });

  it("stops at the third identical tool failure and resets after success event", () => {
    const guard = new RunGuard({ toolRetryLimit: 3 });
    const args = { b: 2, password: "secret", a: 1 };
    expect(guard.toolFailure("patch", args).stop).toBe(false);
    expect(guard.toolFailure("patch", { a: 1, b: 2, password: "secret" }).stop).toBe(false);
    expect(guard.toolFailure("patch", args)).toEqual({ stop: true, reason: "tool_retry_loop" });
    guard.event();
    expect(guard.toolFailure("patch", args).stop).toBe(false);
  });

  it("hashes arguments without exposing their values", () => {
    const signature = toolFailureSignature("patch", { token: "private" });
    expect(signature).not.toContain("private");
    expect(signature).toHaveLength(64);
  });
});
