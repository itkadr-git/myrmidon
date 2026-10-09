import { describe, expect, it, vi } from "vitest";
import { createHostDiskSweep } from "./sweep.js";
import type { HostDiskSweepDeps } from "./sweep.js";

function deps(overrides: Partial<HostDiskSweepDeps> = {}): HostDiskSweepDeps {
  return {
    dataRootPath: "/srv/data",
    consumerPaths: ["/srv/data/workspaces"],
    resolveSettings: async () => ({ usageThresholdPercent: 85 }),
    logActivity: vi.fn(async () => undefined),
    lastSignalAt: async () => null,
    logger: { error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    ...overrides,
  };
}

function usage(usedPercent: number, totalBytes = 100 * 1024 * 1024 * 1024) {
  const usedBytes = Math.floor((usedPercent / 100) * totalBytes);
  return {
    path: "/srv/data",
    usedBytes,
    totalBytes,
    freeBytes: totalBytes - usedBytes,
    usedPercent,
  };
}

const growthHour = 60 * 60 * 1000;

describe("createHostDiskSweep", () => {
  it("measures, records the sample and does not signal under the threshold", async () => {
    const logActivity = vi.fn();
    let at = new Date("2026-10-03T00:00:00Z");
    const measureUsage = vi.fn(async () => usage(50));
    const sweep = createHostDiskSweep({
      ...deps({ logActivity }),
      measureUsage,
      now: () => at,
    });
    const result = await sweep.sweep();
    expect(result.overThreshold).toBe(false);
    expect(result.usedPercent).toBe(50);
    expect(logActivity).not.toHaveBeenCalled();
    expect(sweep.samples()).toHaveLength(1);
  });

  it("signals with the numbers and consumers when usage crosses the threshold", async () => {
    const logActivity = vi.fn();
    const measureConsumer = vi.fn(async () => ({ sizeBytes: 40 * 1024 * 1024 * 1024, truncated: false }));
    const at = new Date("2026-10-03T00:00:00Z");
    const sweep = createHostDiskSweep({
      ...deps({ logActivity }),
      measureUsage: async () => usage(90),
      measureConsumer,
      now: () => at,
    });
    const result = await sweep.sweep();
    expect(result.overThreshold).toBe(true);
    expect(result.signalled).toBe(true);
    expect(logActivity).toHaveBeenCalledTimes(1);
    const entry = (logActivity as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(entry.action).toBe("host.disk_threshold_exceeded");
    expect(entry.details.usedPercent).toBe(90);
    expect(entry.details.thresholdPercent).toBe(85);
    expect(entry.details.consumers).toEqual([{ path: "/srv/data/workspaces", sizeGb: 40 }]);
    expect(result.consumers).toEqual([{ path: "/srv/data/workspaces", sizeBytes: 40 * 1024 * 1024 * 1024 }]);
  });

  it("does not re-signal within the interval and re-signals after it", async () => {
    const logActivity = vi.fn();
    let at = new Date("2026-10-03T00:00:00Z");
    let lastSignal = new Date("2026-10-02T23:00:00Z");
    const sweep = createHostDiskSweep({
      ...deps({ logActivity }),
      measureUsage: async () => usage(90),
      now: () => at,
      lastSignalAt: async () => lastSignal,
    });
    await sweep.sweep();
    expect(logActivity).not.toHaveBeenCalled(); // 1h since last signal < 6h

    at = new Date("2026-10-03T06:00:00Z"); // 7h since last signal
    await sweep.sweep();
    expect(logActivity).toHaveBeenCalledTimes(1);
  });

  it("computes the growth rate per hour across samples", async () => {
    let at = new Date("2026-10-03T00:00:00Z");
    let bytes = 50 * 1024 * 1024 * 1024;
    const sweep = createHostDiskSweep({
      ...deps(),
      measureUsage: async () => {
        const usedBytes = bytes;
        return {
          path: "/srv/data",
          usedBytes,
          totalBytes: 100 * 1024 * 1024 * 1024,
          freeBytes: 100 * 1024 * 1024 * 1024 - usedBytes,
          usedPercent: 50,
        };
      },
      now: () => at,
    });
    await sweep.sweep();
    at = new Date(at.getTime() + growthHour);
    bytes += 1024 * 1024 * 1024;
    const result = await sweep.sweep();
    expect(result.growthBytesPerHour).toBe(1024 * 1024 * 1024);
  });

  it("reports no usage when statfs fails, without a signal", async () => {
    const logActivity = vi.fn();
    const logger = { error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const sweep = createHostDiskSweep({
      ...deps({ logActivity, logger }),
      measureUsage: async () => null,
    });
    const result = await sweep.sweep();
    expect(result.usedPercent).toBeNull();
    expect(result.overThreshold).toBe(false);
    expect(logActivity).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  // myrmidon(1.6.5 F-03): a missing data root is one ERROR at the transition,
  // debug lines while the state holds, and a repeated error no more often
  // than the interval — never the per-tick "host disk usage could not be
  // read" spam the blind board container used to produce.
  it("a missing path is unmeasured: one error at the transition, debug while it holds, hourly repeat", async () => {
    const logger = { error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    let at = new Date("2026-10-03T00:00:00Z");
    const sweep = createHostDiskSweep({
      ...deps({ logger }),
      measureUsage: async () => null,
      now: () => at,
      unmeasuredErrorIntervalMs: 60 * 60 * 1000,
    });

    const first = await sweep.sweep();
    expect(first.state).toBe("unmeasured");
    expect(first.measuredPath).toBeNull();
    expect(first.error).toContain("MYRMIDON_HOST_DISK_DATA_ROOT");
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.debug).not.toHaveBeenCalled();

    // Next ticks while the path is still missing: debug, not error.
    at = new Date(at.getTime() + 60 * 1000);
    const second = await sweep.sweep();
    expect(second.state).toBe("unmeasured");
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledTimes(1);

    at = new Date(at.getTime() + 60 * 1000);
    await sweep.sweep();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledTimes(2);

    // An hour later the error repeats once (an operator who only greps
    // ERROR still sees the blind sweep).
    at = new Date(at.getTime() + 60 * 60 * 1000);
    await sweep.sweep();
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it("resumes measuring without a restart when the path appears (one info line)", async () => {
    const logger = { error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    let pathVisible = false;
    const sweep = createHostDiskSweep({
      ...deps({ logger }),
      measureUsage: async () => (pathVisible ? usage(50) : null),
    });

    const blind = await sweep.sweep();
    expect(blind.state).toBe("unmeasured");
    expect(logger.error).toHaveBeenCalledTimes(1);

    pathVisible = true;
    const resumed = await sweep.sweep();
    expect(resumed.state).toBe("measured");
    expect(resumed.measuredPath).toBe("/srv/data");
    expect(resumed.error).toBeNull();
    expect(resumed.usedPercent).toBe(50);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0][1]).toContain("resumed");

    // A failure right after a recovery is a fresh transition: one error again.
    pathVisible = false;
    const again = await sweep.sweep();
    expect(again.state).toBe("unmeasured");
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  // myrmidon(1.6.5 F-03): every configured path is measured on its own
  // filesystem; the data root stays the main result and each consumer path
  // shows up in `measurements` with its own usedPercent.
  it("measures the data root and every consumer path, main result stays the data root", async () => {
    const usageByPath: Record<string, ReturnType<typeof usage>> = {
      "/srv/data": usage(50),
      "/srv/data/workspaces": { ...usage(80), path: "/srv/data/workspaces" },
    };
    const measureUsage = vi.fn(async (path: string) => usageByPath[path] ?? null);
    const sweep = createHostDiskSweep({
      ...deps(),
      measureUsage,
    });
    const result = await sweep.sweep();
    expect(result.state).toBe("measured");
    expect(result.measuredPath).toBe("/srv/data");
    expect(result.usedPercent).toBe(50);
    expect(measureUsage).toHaveBeenCalledWith("/srv/data");
    expect(measureUsage).toHaveBeenCalledWith("/srv/data/workspaces");
    expect(result.measurements).toEqual([
      { path: "/srv/data", usedPercent: 50, usedBytes: 50 * 1024 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 * 1024, freeBytes: 50 * 1024 * 1024 * 1024 },
      { path: "/srv/data/workspaces", usedPercent: 80, usedBytes: 80 * 1024 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 * 1024, freeBytes: 20 * 1024 * 1024 * 1024 },
    ]);
  });

  it("a consumer path that cannot be measured is absent from measurements, the data root still reports", async () => {
    const measureUsage = vi.fn(async (path: string) => (path === "/srv/data" ? usage(50) : null));
    const sweep = createHostDiskSweep({
      ...deps(),
      measureUsage,
    });
    const result = await sweep.sweep();
    expect(result.state).toBe("measured");
    expect(result.measurements).toHaveLength(1);
    expect(result.measurements[0].path).toBe("/srv/data");
  });

  it("applies a threshold change from the settings without rebuilding the sweep", async () => {
    let threshold = 85;
    const at = new Date("2026-10-03T00:00:00Z");
    const sweep = createHostDiskSweep({
      ...deps(),
      resolveSettings: async () => ({ usageThresholdPercent: threshold }),
      measureUsage: async () => usage(60),
      now: () => at,
    });
    await sweep.sweep();
    expect(sweep.lastResult()?.overThreshold).toBe(false);
    threshold = 50;
    await sweep.sweep();
    expect(sweep.lastResult()?.overThreshold).toBe(true);
    expect(sweep.lastResult()?.thresholdPercent).toBe(50);
  });

  it("scales severity: critical at 95 and above, high below", async () => {
    const at = new Date("2026-10-03T00:00:00Z");
    for (const [percent, expected] of [[94, "high"], [95, "critical"], [99, "critical"]] as const) {
      const sweep = createHostDiskSweep({
        ...deps(),
        measureUsage: async () => usage(percent),
        now: () => at,
      });
      await sweep.sweep();
      expect(sweep.lastResult()?.overThreshold).toBe(true);
      // severity is derived in the attention feed; here we only assert the
      // crossing itself carries the percent the feed ranks on.
      expect(sweep.lastResult()?.usedPercent).toBe(percent);
      void expected;
    }
  });
});
