import { describe, expect, it } from "vitest";
import { botPartitionThresholdRuntimeForTest } from "./partition.js";
import type { BotPartitionUsage } from "./dockergate.js";

const at = "2026-10-27T00:00:00Z";
function usage(usedBytes = 85000): BotPartitionUsage {
  return { mount: "/bots", totalBytes: 100000, usedBytes, freeBytes: 100000 - usedBytes,
    usedPercent: Math.round(usedBytes / 100) / 10, at };
}
function runtime(now = () => new Date(at)) {
  return botPartitionThresholdRuntimeForTest({ now, env: {}, getBotDiskSettings: async () => undefined });
}

describe("physical partition health", () => {
  it.each([[84999, "none"], [85000, "warn"], [85001, "warn"], [90000, "warn"], [95000, "critical"]] as const)(
    "evaluates %i physical bytes, not rounded display percent", async (bytes, alert) => {
      const state = await runtime().updateFromPartition(usage(bytes));
      expect(state.alertLevel).toBe(alert);
      expect(state.partition?.usedPercent).toBeCloseTo(bytes / 1000, 8);
    },
  );
  it.each(["2026-10-26T23:00:00Z", "2026-10-27T01:00:00Z", "invalid"])(
    "rejects stale, future or invalid measurement time %s", async (timestamp) => {
      const rt = runtime();
      const state = await rt.updateFromPartition({ ...usage(10000), at: timestamp });
      expect(state.partition).toBeNull();
      expect(state.alertLevel).toBeNull();
    },
  );
  it.each([{ totalBytes: 0 }, { usedBytes: 100001 }, { usedBytes: NaN }, { freeBytes: -1 }, { freeBytes: 100001 }])(
    "does not present invalid filesystem counters as healthy: %j", async (invalid) => {
      const state = await runtime().updateFromPartition({ ...usage(10000), ...invalid });
      expect(state.alertLevel).toBeNull();
      expect(state.partition).toBeNull();
    },
  );
  it("accepts samples just before expiry and rejects the exact expiry boundary", async () => {
    let clock = new Date(new Date(at).getTime() + 5 * 60 * 1000 - 1);
    const rt = runtime(() => clock);
    expect((await rt.updateFromPartition(usage())).alertLevel).toBe("warn");
    clock = new Date(clock.getTime() + 1);
    expect(rt.current().alertLevel).toBeNull();
  });
  it("expires a previously healthy snapshot when the sweep stops", async () => {
    let clock = new Date(at);
    const rt = runtime(() => clock);
    await rt.updateFromPartition(usage(10000));
    expect(rt.current().alertLevel).toBe("none");
    clock = new Date(clock.getTime() + 60 * 60 * 1000);
    expect(rt.current().alertLevel).toBeNull();
    expect(rt.current().partition).toBeNull();
  });
});
