import { describe, expect, it } from "vitest";
import { botPartitionThresholdRuntimeForTest } from "./partition.js";
import type { BotPartitionUsage } from "./dockergate.js";

const at = "2026-11-16T01:00:00.000Z";
function sample(freeBytes: number): BotPartitionUsage {
  return { mount: "/bots", totalBytes: 1000, usedBytes: 1000 - freeBytes, freeBytes, usedPercent: 0, at };
}

function runtime(stored?: unknown) {
  return botPartitionThresholdRuntimeForTest({
    getBotDiskSettings: async () => stored,
    env: {},
    now: () => new Date(at),
  });
}

describe("bot partition low free space: the card state only, no owner message", () => {
  it("keeps the measurement for the attention card below 10% free and drops it when unmeasured", async () => {
    const rt = runtime();
    const state = await rt.updateFromPartition(sample(99));
    expect(state.partition?.freeBytes).toBe(99);
    expect(rt.current().partition?.mount).toBe("/bots");
    rt.markUnmeasured();
    expect(rt.current().partition).toBeNull();
  });

  it("has no owner notification hook: the runtime only evaluates thresholds", async () => {
    const rt = runtime({ partitionThresholdPercent: 70, partitionRefuseOpenPercent: 80, partitionCriticalPercent: 85 });
    await rt.updateFromPartition({ ...sample(100), usedBytes: 900 });
    expect(rt.current().alertLevel).toBe("critical");
    expect(Object.keys(rt).sort()).toEqual(["current", "markUnmeasured", "resolveThresholds", "updateFromPartition"]);
  });

  it("does not interpret reserved filesystem blocks as free space", async () => {
    const rt = runtime();
    const state = await rt.updateFromPartition({ ...sample(99), usedBytes: 800 });
    expect(state.partition?.freeBytes).toBe(99);
    expect(state.partition!.usedBytes / state.partition!.totalBytes).toBe(0.8);
  });

  it("an invalid physical measurement is not evidence", async () => {
    const rt = runtime();
    await rt.updateFromPartition(sample(99));
    await rt.updateFromPartition({ ...sample(99), totalBytes: 0 });
    expect(rt.current().partition).toBeNull();
  });
});
