import { describe, expect, it, vi } from "vitest";
import {
  HOST_CPU_HOLD_SIGNAL_MS,
  HOST_MEMORY_HOLD_SIGNAL_MS,
  applyRunAdmissionLimits,
  createRunAdmission,
  currentRunAdmissionLimits,
  hostCpuHoldSignal,
  hostMemoryHoldSignal,
  readHostCpuLoad,
  readHostMemory,
  readCgroupFreeMemoryBytes,
  readRunAdmissionLimits,
  resetSharedRunAdmissionForTests,
  scheduleQueuedResweep,
} from "./run-admission.js";

const NO_MEMORY = {
  minFreeMemoryMb: null,
  runMemoryEstimateMb: 300,
  minFreeHostMemoryMb: null,
  // myrmidon(1.6.5): off unless a test says otherwise.
  maxHostLoadPercentPerCore: null,
};
const MB = 1024 * 1024;

describe("readRunAdmissionLimits", () => {
  it("treats unset, empty, zero and garbage as no limit; the ramp, the host floor and the CPU ceiling default on", () => {
    const DEFAULT_ON = { maxStartsPerMinute: 5, minFreeHostMemoryMb: 15360, maxHostLoadPercentPerCore: 90 };
    expect(readRunAdmissionLimits({})).toEqual({
      maxConcurrentRuns: null,
      minFreeMemoryMb: null,
      runMemoryEstimateMb: 300,
      ...DEFAULT_ON,
    });
    expect(
      readRunAdmissionLimits({ MYRMIDON_MAX_CONCURRENT_RUNS: "0", MYRMIDON_MAX_RUN_STARTS_PER_MINUTE: "x" }),
    ).toEqual({ maxConcurrentRuns: null, minFreeMemoryMb: null, runMemoryEstimateMb: 300, ...DEFAULT_ON });
    expect(
      readRunAdmissionLimits({ MYRMIDON_MAX_RUN_STARTS_PER_MINUTE: "0", MYRMIDON_MIN_FREE_HOST_MEMORY_MB: "off" }),
    ).toEqual({ maxConcurrentRuns: null, maxStartsPerMinute: null, ...NO_MEMORY, maxHostLoadPercentPerCore: 90 });
    expect(
      readRunAdmissionLimits({
        MYRMIDON_MAX_CONCURRENT_RUNS: " 12 ",
        MYRMIDON_MAX_RUN_STARTS_PER_MINUTE: "6",
        MYRMIDON_MIN_FREE_MEMORY_MB: "1500",
        MYRMIDON_RUN_MEMORY_ESTIMATE_MB: "250",
        MYRMIDON_MIN_FREE_HOST_MEMORY_MB: "8192",
        MYRMIDON_MAX_HOST_LOAD_PERCENT_PER_CORE: "off",
      }),
    ).toEqual({
      maxConcurrentRuns: 12,
      maxStartsPerMinute: 6,
      minFreeMemoryMb: 1500,
      runMemoryEstimateMb: 250,
      minFreeHostMemoryMb: 8192,
      maxHostLoadPercentPerCore: null,
    });
  });
});

describe("createRunAdmission", () => {
  it("passes the per-agent slots through when no limit is set", () => {
    const admission = createRunAdmission({ limits: { maxConcurrentRuns: null, maxStartsPerMinute: null, ...NO_MEMORY } });
    expect(admission.reserve(3)).toBe(3);
  });

  it("never admits more than the cap when 40 agents wake at once", async () => {
    const admission = createRunAdmission({ limits: { maxConcurrentRuns: 5, maxStartsPerMinute: null, ...NO_MEMORY } });
    // Each agent reserves one slot, then awaits its claim before the next one runs.
    const started = await Promise.all(
      Array.from({ length: 40 }, async () => {
        const slots = admission.reserve(1);
        await new Promise((resolve) => setTimeout(resolve, 1));
        return slots;
      }),
    );
    expect(started.reduce((sum, n) => sum + n, 0)).toBe(5);
  });

  it("frees a slot when a run finishes and when a reserved slot is unused", () => {
    const admission = createRunAdmission({ limits: { maxConcurrentRuns: 2, maxStartsPerMinute: null, ...NO_MEMORY } });
    expect(admission.reserve(3)).toBe(2);
    expect(admission.reserve(1)).toBe(0);
    admission.finish();
    expect(admission.reserve(1)).toBe(1);
    admission.release(1);
    expect(admission.reserve(1)).toBe(1);
  });

  it("limits starts per sliding minute and gives back unused starts", () => {
    let clock = 0;
    const admission = createRunAdmission({
      limits: { maxConcurrentRuns: null, maxStartsPerMinute: 2, ...NO_MEMORY },
      now: () => clock,
    });
    expect(admission.reserve(3)).toBe(2);
    admission.release(1);
    expect(admission.reserve(3)).toBe(1);
    expect(admission.reserve(1)).toBe(0);
    clock = 60_000;
    expect(admission.reserve(1)).toBe(1);
  });
});

describe("memory headroom", () => {
  it("admits only runs that fit above the floor, counting runs still settling", () => {
    let clock = 0;
    let free = 2500 * MB;
    const admission = createRunAdmission({
      limits: {
        maxConcurrentRuns: null,
        maxStartsPerMinute: null,
        minFreeMemoryMb: 1500,
        runMemoryEstimateMb: 300,
        minFreeHostMemoryMb: null,
        maxHostLoadPercentPerCore: null,
      },
      freeMemoryBytes: () => free,
      now: () => clock,
    });
    // 1000 MB above the floor fits three 300 MB runs.
    expect(admission.reserve(10)).toBe(3);
    // The cgroup has not grown yet, but the three runs are still settling.
    expect(admission.reserve(10)).toBe(0);
    clock = 30_000;
    free = 1600 * MB;
    expect(admission.reserve(10)).toBe(0);
  });

  it("leaves the other limits in charge when free memory is unknown", () => {
    const admission = createRunAdmission({
      limits: {
        maxConcurrentRuns: 4,
        maxStartsPerMinute: null,
        minFreeMemoryMb: 1500,
        runMemoryEstimateMb: 300,
        minFreeHostMemoryMb: null,
        maxHostLoadPercentPerCore: null,
      },
      freeMemoryBytes: () => null,
    });
    expect(admission.reserve(10)).toBe(4);
  });

  it("reads cgroup v2 memory without reclaimable inactive cache", () => {
    const files: Record<string, string> = {
      "/cg/memory.max": "8589934592\n",
      "/cg/memory.current": "7800532992\n",
      "/cg/memory.stat": "anon 4545642496\ninactive_file 2337927168\nactive_file 401641472\n",
    };
    expect(readCgroupFreeMemoryBytes("/cg", (path) => files[path]!)).toBe(8589934592 - (7800532992 - 2337927168));
    expect(readCgroupFreeMemoryBytes("/cg", (path) => (path.endsWith("max") ? "max" : "0"))).toBeNull();
    expect(
      readCgroupFreeMemoryBytes("/none", () => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
  });
});

describe("live limit changes", () => {
  const NO_MEMORY_LIMITS = {
    minFreeMemoryMb: null,
    runMemoryEstimateMb: 300,
    minFreeHostMemoryMb: null,
    maxHostLoadPercentPerCore: null,
  };

  it("lets the runs held behind the old ceiling start as soon as it is raised", () => {
    const admission = createRunAdmission({ limits: { maxConcurrentRuns: 1, maxStartsPerMinute: null, ...NO_MEMORY_LIMITS } });
    // One slot: one run starts, the next two wait for the queue sweep.
    expect(admission.reserve(3)).toBe(1);
    expect(admission.limited()).toBe(true);
    admission.updateLimits({ maxConcurrentRuns: 3, maxStartsPerMinute: null, ...NO_MEMORY_LIMITS });
    // The same admission object admits them now — no restart, no lost count.
    expect(admission.reserve(3)).toBe(2);
  });

  it("keeps the run count and the start-rate window across a change", () => {
    let clock = 0;
    const admission = createRunAdmission({
      limits: { maxConcurrentRuns: 2, maxStartsPerMinute: 2, ...NO_MEMORY_LIMITS },
      now: () => clock,
    });
    expect(admission.reserve(2)).toBe(2);
    admission.updateLimits({ maxConcurrentRuns: 5, maxStartsPerMinute: 2, ...NO_MEMORY_LIMITS });
    // The two starts of this minute still count, and the two runs still run.
    expect(admission.reserve(5)).toBe(0);
    clock = 60_000;
    // The window rolled over, but its own cap of two starts still holds.
    expect(admission.reserve(5)).toBe(2);
  });

  it("lowers the ceiling without dropping runs already in flight", () => {
    const admission = createRunAdmission({ limits: { maxConcurrentRuns: 4, maxStartsPerMinute: null, ...NO_MEMORY_LIMITS } });
    expect(admission.reserve(4)).toBe(4);
    admission.updateLimits({ maxConcurrentRuns: 2, maxStartsPerMinute: null, ...NO_MEMORY_LIMITS });
    expect(admission.reserve(1)).toBe(0);
    admission.finish();
    expect(admission.reserve(1)).toBe(0);
    admission.finish();
    admission.finish();
    // One run is still in flight, so exactly one of the two new slots is free.
    expect(admission.reserve(2)).toBe(1);
  });

  it("applies limits to the process-wide admission and reports them back", () => {
    resetSharedRunAdmissionForTests();
    try {
      applyRunAdmissionLimits({
        maxConcurrentRuns: 7,
        maxStartsPerMinute: 3,
        minFreeMemoryMb: 900,
        runMemoryEstimateMb: 200,
        minFreeHostMemoryMb: 10240,
        maxHostLoadPercentPerCore: 150,
      });
      expect(currentRunAdmissionLimits()).toEqual({
        maxConcurrentRuns: 7,
        maxStartsPerMinute: 3,
        minFreeMemoryMb: 900,
        runMemoryEstimateMb: 200,
        minFreeHostMemoryMb: 10240,
        maxHostLoadPercentPerCore: 150,
      });
      applyRunAdmissionLimits({
        maxConcurrentRuns: null,
        maxStartsPerMinute: null,
        minFreeMemoryMb: null,
        runMemoryEstimateMb: 300,
        minFreeHostMemoryMb: null,
        maxHostLoadPercentPerCore: null,
      });
      expect(currentRunAdmissionLimits()).toEqual({
        maxConcurrentRuns: null,
        maxStartsPerMinute: null,
        minFreeMemoryMb: null,
        runMemoryEstimateMb: 300,
        minFreeHostMemoryMb: null,
        maxHostLoadPercentPerCore: null,
      });
    } finally {
      resetSharedRunAdmissionForTests();
    }
  });
});

describe("drift and resweep", () => {
  it("raises the count to the database but never lowers it", () => {
    const admission = createRunAdmission({ limits: { maxConcurrentRuns: 12, maxStartsPerMinute: null, ...NO_MEMORY } });
    expect(admission.reserve(2)).toBe(2);
    // An execution settled while its row still runs: the database says 12.
    admission.finish();
    admission.syncRunning(12);
    expect(admission.reserve(1)).toBe(0);
    admission.syncRunning(3);
    expect(admission.reserve(1)).toBe(0);
  });

  it("reports when a limit held runs back", () => {
    const admission = createRunAdmission({ limits: { maxConcurrentRuns: 1, maxStartsPerMinute: null, ...NO_MEMORY } });
    expect(admission.reserve(1)).toBe(1);
    expect(admission.limited()).toBe(false);
    expect(admission.reserve(2)).toBe(0);
    expect(admission.limited()).toBe(true);
  });

  it("schedules one resweep for many calls", () => {
    vi.useFakeTimers();
    try {
      const sweep = vi.fn();
      scheduleQueuedResweep(sweep, 1000);
      scheduleQueuedResweep(sweep, 1000);
      vi.advanceTimersByTime(1000);
      expect(sweep).toHaveBeenCalledTimes(1);
      scheduleQueuedResweep(sweep, 1000);
      vi.advanceTimersByTime(1000);
      expect(sweep).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("myrmidon(1.6.2 RUN-ADMISSION) host memory floor", () => {
  const GB = 1024 * MB;
  const HOST_FLOOR = {
    maxConcurrentRuns: null,
    maxStartsPerMinute: null,
    minFreeMemoryMb: null,
    runMemoryEstimateMb: 300,
    minFreeHostMemoryMb: 15360,
    // myrmidon(1.6.5): the CPU ceiling stays off here so the memory tests
    // read only memory; the CPU suite below sets its own limits.
    maxHostLoadPercentPerCore: null,
  };
  const host = (availableBytes: number) => () => ({ known: true as const, availableBytes, totalBytes: 64 * GB });

  it("holds every new run while host MemAvailable is below the floor and admits again once it rises", () => {
    let available = 7 * GB;
    const admission = createRunAdmission({ limits: { ...HOST_FLOOR }, hostMemory: () => host(available)() });
    expect(admission.reserve(5)).toBe(0);
    expect(admission.limited()).toBe(true);
    expect(admission.hostMemoryGate()).toMatchObject({ state: "closed", availableMb: 7168, thresholdMb: 15360 });
    available = 20 * GB;
    expect(admission.reserve(2)).toBe(2);
    expect(admission.hostMemoryGate().state).toBe("open");
  });

  it("budgets runs still starting against the floor, so one reading does not admit a burst", () => {
    let clock = 0;
    const admission = createRunAdmission({
      // 16 GB available, floor 15 GB, 600 MB a run: the second start is
      // admitted with one run settling (16384 - 600 >= 15360), the third is
      // not (16384 - 1200 < 15360).
      limits: { ...HOST_FLOOR, runMemoryEstimateMb: 600 },
      hostMemory: host(16 * GB),
      now: () => clock,
    });
    expect(admission.reserve(1)).toBe(1);
    expect(admission.reserve(1)).toBe(1);
    expect(admission.reserve(1)).toBe(0);
    expect(admission.hostMemoryGate()).toMatchObject({ state: "closed", settlingRuns: 2 });
    // The settled runs are in MemAvailable now (the fake reading stays 16 GB).
    clock = 30_000;
    expect(admission.reserve(1)).toBe(1);
  });

  it("combines with the start ramp: the ramp spreads starts even with plenty of host memory", () => {
    let clock = 0;
    const admission = createRunAdmission({
      limits: { ...HOST_FLOOR, maxStartsPerMinute: 5 },
      hostMemory: host(60 * GB),
      now: () => clock,
    });
    expect(admission.reserve(23)).toBe(5);
    expect(admission.reserve(1)).toBe(0);
    clock = 60_000;
    expect(admission.reserve(23)).toBe(5);
  });

  it("does not read the host when the floor is off, and leaves the other limits in charge when unreadable", () => {
    const read = vi.fn(host(1 * GB));
    const off = createRunAdmission({ limits: { ...HOST_FLOOR, minFreeHostMemoryMb: null }, hostMemory: read });
    expect(off.reserve(3)).toBe(3);
    expect(read).not.toHaveBeenCalled();
    expect(off.hostMemoryGate().state).toBe("off");

    const unavailable = vi.fn();
    const unknown = createRunAdmission({
      limits: { ...HOST_FLOOR, maxConcurrentRuns: 2 },
      hostMemory: () => ({ known: false, reason: "no meminfo" }),
      onHostMemoryUnavailable: unavailable,
    });
    expect(unknown.reserve(5)).toBe(2);
    expect(unavailable).toHaveBeenCalledWith("no meminfo");
    expect(unknown.hostMemoryGate()).toMatchObject({ state: "unknown", reason: "no meminfo" });
  });

  it("applies a floor changed on the fly to the next reservation", () => {
    const admission = createRunAdmission({ limits: { ...HOST_FLOOR }, hostMemory: host(10 * GB) });
    expect(admission.reserve(1)).toBe(0);
    admission.updateLimits({ ...HOST_FLOOR, minFreeHostMemoryMb: 8192 });
    expect(admission.reserve(1)).toBe(1);
    admission.updateLimits({ ...HOST_FLOOR, minFreeHostMemoryMb: null });
    expect(admission.reserve(1)).toBe(1);
  });

  it("raises the attention signal only after ten minutes of continuous hold", () => {
    let clock = Date.parse("2026-10-04T01:00:00Z");
    let available = 7 * GB;
    const events: string[] = [];
    const admission = createRunAdmission({
      limits: { ...HOST_FLOOR },
      hostMemory: () => host(available)(),
      onHostMemoryHold: (event) => events.push(event.state),
      now: () => clock,
    });
    expect(admission.reserve(1)).toBe(0);
    // The resweep keeps meeting the closed floor every 15 s.
    for (let i = 0; i < 39; i += 1) {
      clock += 15_000;
      admission.reserve(1);
    }
    const gate = admission.hostMemoryGate();
    expect(gate.heldSince?.toISOString()).toBe("2026-10-04T01:00:00.000Z");
    expect(hostMemoryHoldSignal(gate, clock)).toBeNull();
    clock += 15_000;
    admission.reserve(1);
    const signal = hostMemoryHoldSignal(admission.hostMemoryGate(), clock);
    expect(signal).toMatchObject({ availableMb: 7168, thresholdMb: 15360 });
    expect(signal!.heldMs).toBeGreaterThanOrEqual(HOST_MEMORY_HOLD_SIGNAL_MS);
    // One "closed" line for the whole hold, not one per resweep.
    expect(events).toEqual(["closed"]);

    available = 20 * GB;
    expect(admission.reserve(1)).toBe(1);
    expect(events).toEqual(["closed", "open"]);
    expect(hostMemoryHoldSignal(admission.hostMemoryGate(), clock)).toBeNull();
  });

  it("starts a new hold when the queue stopped asking in between", () => {
    let clock = 0;
    const admission = createRunAdmission({ limits: { ...HOST_FLOOR }, hostMemory: host(7 * GB), now: () => clock });
    admission.reserve(1);
    clock = 60_000;
    admission.reserve(1);
    expect(admission.hostMemoryGate().heldSince?.getTime()).toBe(0);
    // Nobody asked for 13 minutes: the next hold starts from scratch.
    clock = 14 * 60_000;
    admission.reserve(1);
    expect(admission.hostMemoryGate().heldSince?.getTime()).toBe(14 * 60_000);
    expect(hostMemoryHoldSignal(admission.hostMemoryGate(), 15 * 60_000)).toBeNull();
  });

  it("reads MemAvailable from meminfo and refuses a container-scoped meminfo", () => {
    const meminfo = "MemTotal:       69948044 kB\nMemFree:  1000 kB\nMemAvailable:    9907000 kB\n";
    const files: Record<string, string> = { "/proc/meminfo": meminfo, "/cg/memory.max": "8589934592\n" };
    const read = (path: string) => {
      const value = files[path];
      if (value === undefined) throw new Error("ENOENT");
      return value;
    };
    expect(readHostMemory({ cgroupRoot: "/cg", readFile: read })).toEqual({
      known: true,
      availableBytes: 9907000 * 1024,
      totalBytes: 69948044 * 1024,
    });
    // lxcfs: MemTotal is the container limit (8 GB), not the host.
    files["/proc/meminfo"] = "MemTotal:        8388608 kB\nMemAvailable:    2000000 kB\n";
    const scoped = readHostMemory({ cgroupRoot: "/cg", readFile: read });
    expect(scoped.known).toBe(false);
    // A host file mounted elsewhere is read from the configured path.
    files["/host/meminfo"] = meminfo;
    expect(readHostMemory({ meminfoPath: "/host/meminfo", cgroupRoot: "/cg", readFile: read }).known).toBe(true);
    expect(readHostMemory({ meminfoPath: "/missing", readFile: read })).toMatchObject({ known: false });
    files["/proc/meminfo"] = "MemTotal: 100 kB\n";
    expect(readHostMemory({ cgroupRoot: "/none", readFile: read }).known).toBe(false);
  });
});

describe("myrmidon(1.6.5 RUN-ADMISSION) host CPU ceiling", () => {
  // Limits with the memory floor off and the CPU ceiling on (the night of
  // 05.10: memory stayed open while load ran at 594 % of a core per core).
  const CPU_CEILING = {
    maxConcurrentRuns: null,
    maxStartsPerMinute: null,
    ...NO_MEMORY,
    maxHostLoadPercentPerCore: 90,
  };
  const cpu = (load1: number, cores = 16) => () => ({ known: true as const, load1, cores });

  it("holds every new run while load per core is at or above the ceiling and admits again once it drops", () => {
    let load = 95;
    const admission = createRunAdmission({ limits: { ...CPU_CEILING }, hostCpuLoad: () => cpu(load)() });
    expect(admission.reserve(3)).toBe(0);
    expect(admission.limited()).toBe(true);
    expect(admission.hostCpuGate()).toMatchObject({
      state: "closed",
      load1: 95,
      cores: 16,
      loadPercentPerCore: 594,
      thresholdPercent: 90,
    });
    load = 12; // 12/16 = 75 % of a core: below the ceiling.
    expect(admission.reserve(2)).toBe(2);
    expect(admission.hostCpuGate().state).toBe("open");
  });

  it("compares against the core count, not the absolute load", () => {
    // load 4 on 2 cores = 200 % — closed; the same reading on 8 cores = 50 % — open.
    const admission = createRunAdmission({
      limits: { ...CPU_CEILING },
      hostCpuLoad: cpu(4, 2),
    });
    expect(admission.reserve(1)).toBe(0);
    const roomy = createRunAdmission({
      limits: { ...CPU_CEILING },
      hostCpuLoad: cpu(4, 8),
    });
    expect(roomy.reserve(1)).toBe(1);
  });

  it("does not read the host load when the ceiling is off, and leaves the other limits in charge when unreadable", () => {
    const read = vi.fn(cpu(95));
    const off = createRunAdmission({ limits: { ...CPU_CEILING, maxHostLoadPercentPerCore: null }, hostCpuLoad: read });
    expect(off.reserve(3)).toBe(3);
    expect(read).not.toHaveBeenCalled();
    expect(off.hostCpuGate().state).toBe("off");

    const unavailable = vi.fn();
    const unknown = createRunAdmission({
      limits: { ...CPU_CEILING, maxConcurrentRuns: 2 },
      hostCpuLoad: () => ({ known: false, reason: "no loadavg" }),
      onHostCpuUnavailable: unavailable,
    });
    expect(unknown.reserve(5)).toBe(2);
    expect(unavailable).toHaveBeenCalledWith("no loadavg");
    expect(unknown.hostCpuGate()).toMatchObject({ state: "unknown", reason: "no loadavg" });
  });

  it("applies a ceiling changed on the fly to the next reservation", () => {
    const admission = createRunAdmission({ limits: { ...CPU_CEILING }, hostCpuLoad: cpu(30, 16) }); // 188 %
    expect(admission.reserve(1)).toBe(0);
    admission.updateLimits({ ...CPU_CEILING, maxHostLoadPercentPerCore: 200 });
    expect(admission.reserve(1)).toBe(1);
    admission.updateLimits({ ...CPU_CEILING, maxHostLoadPercentPerCore: null });
    expect(admission.reserve(1)).toBe(1);
  });

  it("holds on both gates at once without mixing them up", () => {
    // Both gates hold independently: reserve() checks memory first, then CPU.
    const admission = createRunAdmission({
      limits: {
        ...NO_MEMORY,
        maxConcurrentRuns: null,
        maxStartsPerMinute: null,
        minFreeHostMemoryMb: 15360,
        maxHostLoadPercentPerCore: 90,
      },
      hostMemory: () => ({ known: true, availableBytes: 7 * 1024 * MB, totalBytes: 64 * 1024 * MB }),
      hostCpuLoad: cpu(16, 16), // exactly 100 % >= 90: closed
    });
    expect(admission.reserve(1)).toBe(0);
    expect(admission.hostMemoryGate().state).toBe("closed");
    expect(admission.hostCpuGate().state).toBe("closed");
  });

  it("raises the CPU attention signal only after ten minutes of continuous hold", () => {
    let clock = Date.parse("2026-10-05T01:00:00Z");
    let load = 95;
    const events: string[] = [];
    const admission = createRunAdmission({
      limits: { ...CPU_CEILING },
      hostCpuLoad: () => cpu(load)(),
      onHostCpuHold: (event) => events.push(event.state),
      now: () => clock,
    });
    expect(admission.reserve(1)).toBe(0);
    for (let i = 0; i < 39; i += 1) {
      clock += 15_000;
      admission.reserve(1);
    }
    const gate = admission.hostCpuGate();
    expect(gate.heldSince?.toISOString()).toBe("2026-10-05T01:00:00.000Z");
    expect(hostCpuHoldSignal(gate, clock)).toBeNull();
    clock += 15_000;
    admission.reserve(1);
    const signal = hostCpuHoldSignal(admission.hostCpuGate(), clock);
    expect(signal).toMatchObject({ load1: 95, cores: 16, loadPercentPerCore: 594, thresholdPercent: 90 });
    expect(signal!.heldMs).toBeGreaterThanOrEqual(HOST_CPU_HOLD_SIGNAL_MS);
    // One "closed" line for the whole hold, not one per resweep.
    expect(events).toEqual(["closed"]);

    load = 8; // 50 % of a core: open.
    expect(admission.reserve(1)).toBe(1);
    expect(events).toEqual(["closed", "open"]);
    expect(hostCpuHoldSignal(admission.hostCpuGate(), clock)).toBeNull();
  });

  it("starts a new CPU hold when the queue stopped asking in between", () => {
    let clock = 0;
    const admission = createRunAdmission({ limits: { ...CPU_CEILING }, hostCpuLoad: cpu(95), now: () => clock });
    admission.reserve(1);
    clock = 60_000;
    admission.reserve(1);
    expect(admission.hostCpuGate().heldSince?.getTime()).toBe(0);
    // Nobody asked for 13 minutes: the next hold starts from scratch.
    clock = 14 * 60_000;
    admission.reserve(1);
    expect(admission.hostCpuGate().heldSince?.getTime()).toBe(14 * 60_000);
    expect(hostCpuHoldSignal(admission.hostCpuGate(), 15 * 60_000)).toBeNull();
  });

  it("reads load1 from /proc/loadavg and refuses an unknown core count", () => {
    const loadavg = "0.52 0.58 0.59 1/389 27714\n";
    const read = (path: string) => {
      if (path === "/proc/loadavg") return loadavg;
      throw new Error("ENOENT");
    };
    expect(readHostCpuLoad({ readFile: read, cpuCount: () => 16 })).toEqual({ known: true, load1: 0.52, cores: 16 });
    expect(readHostCpuLoad({ readFile: read, cpuCount: () => 0 })).toMatchObject({ known: false });
    expect(readHostCpuLoad({ loadavgPath: "/host/loadavg", readFile: read })).toMatchObject({ known: false });
    expect(readHostCpuLoad({ readFile: () => "garly\n", cpuCount: () => 4 })).toMatchObject({ known: false });
  });
});
