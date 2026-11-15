// myrmidon(OPE-12557): locked conversation deliveries are bounded per process so
// they cannot exhaust the database pool they also take further connections from.
import { describe, expect, it } from "vitest";
import {
  MAX_CONCURRENT_LOCKED_CONVERSATION_DELIVERIES,
  withConversationDeliverySlot,
} from "./agent-conversations.js";

describe("withConversationDeliverySlot", () => {
  it("runs at most the bounded number of deliveries at once and serves the rest in order", async () => {
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const gates: Array<() => void> = [];
    const jobs = Array.from({ length: 6 }, (_, index) =>
      withConversationDeliverySlot(async () => {
        running += 1;
        peak = Math.max(peak, running);
        order.push(index);
        await new Promise<void>((resolve) => gates.push(resolve));
        running -= 1;
        return index;
      }),
    );
    for (let released = 0; released < 6; released += 1) {
      for (let i = 0; i < 5 && gates.length === 0; i += 1) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      gates.shift()?.();
    }
    expect(await Promise.all(jobs)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(MAX_CONCURRENT_LOCKED_CONVERSATION_DELIVERIES);
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("frees the slot when a delivery throws", async () => {
    await expect(withConversationDeliverySlot(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    const results = await Promise.all(
      Array.from({ length: MAX_CONCURRENT_LOCKED_CONVERSATION_DELIVERIES + 1 }, (_, i) =>
        withConversationDeliverySlot(async () => i),
      ),
    );
    expect(results).toHaveLength(MAX_CONCURRENT_LOCKED_CONVERSATION_DELIVERIES + 1);
  });
});
