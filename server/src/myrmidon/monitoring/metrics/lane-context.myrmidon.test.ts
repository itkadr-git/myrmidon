// myrmidon(1.6.5-PROCS-T02): the lane context contract — the label defaults to
// "unlabeled", nests, survives an await, and is restored after a throw.

import { describe, expect, it } from "vitest";
import { UNLABELED_LANE, currentLane, withLane } from "./lane-context.js";

describe("lane context", () => {
  it("reports unlabeled outside every lane", () => {
    expect(currentLane()).toBe(UNLABELED_LANE);
    expect(UNLABELED_LANE).toBe("unlabeled");
  });

  it("labels the work it runs and restores the outer lane on return", () => {
    const seen: string[] = [];
    withLane("tick", () => {
      seen.push(currentLane());
      withLane("api", () => {
        seen.push(currentLane());
      });
      seen.push(currentLane());
    });
    seen.push(currentLane());
    expect(seen).toEqual(["tick", "api", "tick", "unlabeled"]);
  });

  it("keeps the lane across awaits", async () => {
    await withLane("chat-reconcile", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(currentLane()).toBe("chat-reconcile");
    });
    expect(currentLane()).toBe(UNLABELED_LANE);
  });

  it("reports the default again after the work throws", async () => {
    await expect(
      withLane("bot-reconcile", async () => {
        throw new Error("lane work failed");
      }),
    ).rejects.toThrow("lane work failed");
    expect(currentLane()).toBe(UNLABELED_LANE);
  });

  it("treats an empty or blank label as unlabeled", () => {
    withLane("", () => expect(currentLane()).toBe(UNLABELED_LANE));
    withLane("   ", () => expect(currentLane()).toBe(UNLABELED_LANE));
  });

  it("returns what the labelled work returned", () => {
    expect(withLane("api", () => 42)).toBe(42);
  });
});