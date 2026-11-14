import { describe, expect, it, vi } from "vitest";
import {
  WakeupSingleFlight,
  wakeupSingleFlightKey,
} from "./wakeup-single-flight.js";

// myrmidon(1.8 HIBERNATE, OPE-12961): the duplicate-wake guard. A ready task
// assigned to an idle-stopped agent wakes it through the standard wakeup; a
// second enqueue of the same wake while the first is still running must not
// create a duplicate.
describe("WakeupSingleFlight (OPE-12961)", () => {
  it("collapses a duplicate wake issued while the first wake is in flight", async () => {
    const single = new WakeupSingleFlight();
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const wakeup = vi.fn((_agentId: string, _opts: unknown) => gate);

    const key = wakeupSingleFlightKey("agent-1", { idempotencyKey: "wake:1" });
    const first = single.run(key, () => wakeup("agent-1", {}));
    const duplicate = single.run(key, () => wakeup("agent-1", {}));

    // Already-running wake: the duplicate reuses the in-flight promise and
    // the underlying wakeup is invoked exactly once.
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(single.has(key)).toBe(true);

    release("run-1");
    await expect(first).resolves.toBe("run-1");
    await expect(duplicate).resolves.toBe("run-1");
    // The guard entry clears once the wake settles, so a later legitimate
    // re-wake with the same key passes.
    expect(single.has(key)).toBe(false);
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("lets a new wake with the same key start after the previous one settles", async () => {
    const single = new WakeupSingleFlight();
    const wakeup = vi.fn(async () => "done");
    const key = wakeupSingleFlightKey("agent-1", { idempotencyKey: "wake:2" });
    await single.run(key, () => wakeup());
    await single.run(key, () => wakeup());
    expect(wakeup).toHaveBeenCalledTimes(2);
  });

  it("starts a new wake that is issued in the same tick the previous one settles", async () => {
    // myrmidon(1.8 HIBERNATE, OPE-12961): the guard entry must clear in the
    // same microtask batch as settlement, before a caller's own await
    // continuation resumes — otherwise a legitimate re-wake issued right
    // after the wake settled silently collapsed onto the settled promise.
    const single = new WakeupSingleFlight();
    const wakeup = vi.fn(async () => "done");
    const key = wakeupSingleFlightKey("agent-1", { idempotencyKey: "wake:2b" });
    const first = await single.run(key, () => wakeup());
    expect(first).toBe("done");
    // No tick boundary: issue the next wake immediately after the await of
    // the first one returned.
    const second = await single.run(key, () => wakeup());
    expect(second).toBe("done");
    expect(wakeup).toHaveBeenCalledTimes(2);
    expect(single.has(key)).toBe(false);
  });

  it("keys wakes tied to different comments apart, comment-less wakes together", () => {
    const base = {
      reason: "issue_assigned",
      payload: { issueId: "i-1", wakeCommentId: "c-1" },
    };
    expect(wakeupSingleFlightKey("agent-1", base)).not.toBe(
      wakeupSingleFlightKey("agent-1", {
        ...base,
        payload: { issueId: "i-1", wakeCommentId: "c-2" },
      }),
    );
    expect(
      wakeupSingleFlightKey("agent-1", {
        reason: "issue_assigned",
        payload: { issueId: "i-1" },
      }),
    ).toBe(
      wakeupSingleFlightKey("agent-1", {
        reason: "issue_assigned",
        payload: { issueId: "i-1" },
      }),
    );
  });

  it("does not merge wakes for different keys", async () => {
    const single = new WakeupSingleFlight();
    let releaseA!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      releaseA = resolve;
    });
    const wakeup = vi.fn((key: string) =>
      key === "a" ? gate : Promise.resolve("b"),
    );

    const promiseA = single.run(
      wakeupSingleFlightKey("agent-1", { idempotencyKey: "a" }),
      () => wakeup("a"),
    );
    const promiseB = single.run(
      wakeupSingleFlightKey("agent-1", { idempotencyKey: "b" }),
      () => wakeup("b"),
    );
    expect(wakeup).toHaveBeenCalledTimes(2);

    releaseA("a");
    await expect(promiseA).resolves.toBe("a");
    await expect(promiseB).resolves.toBe("b");
  });

  it("keys by agent, issue and reason when no idempotency key is given", () => {
    const base = { reason: "issue_assigned", payload: { issueId: "i-1" } };
    expect(wakeupSingleFlightKey("agent-1", base)).toBe(
      "agent:agent-1:issue:i-1:reason:issue_assigned",
    );
    expect(wakeupSingleFlightKey("agent-2", base)).not.toBe(
      wakeupSingleFlightKey("agent-1", base),
    );
    expect(
      wakeupSingleFlightKey("agent-1", { ...base, payload: { issueId: "i-2" } }),
    ).not.toBe(wakeupSingleFlightKey("agent-1", base));
  });
});
