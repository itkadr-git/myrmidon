import { describe, expect, it, vi } from "vitest";
import { botPartitionThresholdRuntimeForTest } from "./partition.js";
import type { BotPartitionUsage } from "./dockergate.js";

const at = "2026-11-16T01:00:00.000Z";
function sample(freeBytes: number): BotPartitionUsage {
  return { mount: "/bots", totalBytes: 1000, usedBytes: 1000 - freeBytes, freeBytes, usedPercent: 0, at };
}

describe("bot partition free-space notification", () => {
  it("signals below 10%, deduplicates until recovery, and signals a new crossing", async () => {
    const notifyOwner = vi.fn(async () => undefined);
    const runtime = botPartitionThresholdRuntimeForTest({
      getBotDiskSettings: async () => undefined,
      notifyOwner,
      env: {},
      now: () => new Date(at),
    });
    await runtime.updateFromPartition(sample(101));
    await runtime.updateFromPartition(sample(100));
    expect(notifyOwner).not.toHaveBeenCalled();
    await runtime.updateFromPartition(sample(99));
    await runtime.updateFromPartition(sample(90));
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    await runtime.updateFromPartition(sample(100));
    await runtime.updateFromPartition(sample(99));
    expect(notifyOwner).toHaveBeenCalledTimes(2);
  });

  it("keeps the configured critical alert when reserved blocks leave at least 10% free", async () => {
    const notifyOwner = vi.fn(async () => undefined);
    const runtime = botPartitionThresholdRuntimeForTest({
      getBotDiskSettings: async () => ({ partitionThresholdPercent: 70, partitionRefuseOpenPercent: 80, partitionCriticalPercent: 85 }),
      notifyOwner,
      env: {},
      now: () => new Date(at),
    });
    await runtime.updateFromPartition({ ...sample(100), usedBytes: 900 });
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    expect(runtime.current().alertLevel).toBe("critical");
  });

  it("does not re-arm after an invalid physical measurement", async () => {
    const notifyOwner = vi.fn(async () => undefined);
    const runtime = botPartitionThresholdRuntimeForTest({
      getBotDiskSettings: async () => undefined,
      notifyOwner,
      env: {},
      now: () => new Date(at),
    });
    await runtime.updateFromPartition(sample(99));
    await runtime.updateFromPartition({ ...sample(99), totalBytes: 0 });
    await runtime.updateFromPartition(sample(98));
    expect(notifyOwner).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate a critical notification after an unmeasured interval", async () => {
    const notifyOwner = vi.fn(async () => undefined);
    const runtime = botPartitionThresholdRuntimeForTest({
      getBotDiskSettings: async () => ({ partitionCriticalPercent: 95 }),
      notifyOwner,
      env: {},
      now: () => new Date(at),
    });
    await runtime.updateFromPartition(sample(40));
    runtime.markUnmeasured();
    await runtime.updateFromPartition(sample(30));
    expect(notifyOwner).toHaveBeenCalledTimes(1);
  });

  it("retries a failed notification on the next measurement", async () => {
    const notifyOwner = vi.fn().mockRejectedValueOnce(new Error("outbox unavailable")).mockResolvedValue(undefined);
    const runtime = botPartitionThresholdRuntimeForTest({
      getBotDiskSettings: async () => undefined,
      notifyOwner,
      env: {},
      now: () => new Date(at),
    });
    await runtime.updateFromPartition(sample(99));
    await runtime.updateFromPartition(sample(98));
    await runtime.updateFromPartition(sample(97));
    expect(notifyOwner).toHaveBeenCalledTimes(2);
  });

  it("does not interpret reserved filesystem blocks as free space", async () => {
    const notifyOwner = vi.fn(async () => undefined);
    const runtime = botPartitionThresholdRuntimeForTest({
      getBotDiskSettings: async () => undefined,
      notifyOwner,
      env: {},
      now: () => new Date(at),
    });
    await runtime.updateFromPartition({ ...sample(99), usedBytes: 800 });
    expect(notifyOwner).toHaveBeenCalledTimes(1);
  });

  it("does not re-arm the notification after an unmeasured interval", async () => {
    const notifyOwner = vi.fn(async () => undefined);
    const runtime = botPartitionThresholdRuntimeForTest({
      getBotDiskSettings: async () => undefined,
      notifyOwner,
      env: {},
      now: () => new Date(at),
    });
    await runtime.updateFromPartition(sample(99));
    runtime.markUnmeasured();
    await runtime.updateFromPartition(sample(99));
    expect(notifyOwner).toHaveBeenCalledTimes(1);
  });
});
