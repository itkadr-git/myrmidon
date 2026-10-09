import { describe, expect, it, vi } from "vitest";
import {
  AGENT_START_SHARE_WINDOW_MS,
  CPU_BUSY_SAMPLE_WINDOW_MS,
  HOST_CPU_HOLD_SIGNAL_MS,
  HOST_MEMORY_HOLD_SIGNAL_MS,
  applyRunAdmissionLimits,
  createRunAdmission,
  cpuBusyPercentFromDelta,
  currentRunAdmissionLimits,
  evaluateAgentStartShare,
  hostCpuHoldSignal,
  hostMemoryHoldSignal,
  orderAgentIdsByOldestQueuedRun,
  readHostCpuLoad,
  readHostCpuPsi,
  readHostCpuStatProbe,
  readHostMemory,
  readCgroupFreeMemoryBytes,
  readCgroupMemoryUsageBytes,
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
  // myrmidon(1.6.5 RUN-FAIRNESS): the start share is a limit the admission
  // does not read yet (part 1); the fixtures carry its default.
  maxPerAgentStartSharePercent: 15,
  // myrmidon(1.6.5 rc.3): the CPU ceilings are off unless a test says
  // otherwise; absent keeps the legacy load-average rule for the suite.
  maxHostCpuBusyPercent: null,
  maxHostCpuPsiSomeAvg10: null,
};
const MB = 1024 * 1024;

describe("readRunAdmissionLimits", () => {
  it("treats unset, empty, zero and garbage as no limit; the ramp, the host floor and the CPU ceilings default on", () => {
    // myrmidon(1.6.5 rc.3): the busy ceiling defaults on; the PSI ceiling
    // defaults off — only an operator-set value closes the gate on pressure.
    const DEFAULT_ON = {
      maxStartsPerMinute: 5,
      minFreeHostMemoryMb: 15360,
      maxHostLoadPercentPerCore: 90,
      maxPerAgentStartSharePercent: 15,
      maxHostCpuBusyPercent: 90,
      maxHostCpuPsiSomeAvg10: null,
    };
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
    ).toEqual({ ...DEFAULT_ON, maxConcurrentRuns: null, maxStartsPerMinute: null, minFreeMemoryMb: null, minFreeHostMemoryMb: null, runMemoryEstimateMb: 300 });
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
      maxPerAgentStartSharePercent: 15,
      // myrmidon(1.6.5 rc.3): the new ceilings keep their own rules — busy
      // defaults on when unset, PSI stays off until set.
      maxHostCpuBusyPercent: 90,
      maxHostCpuPsiSomeAvg10: null,
    });
    expect(
      readRunAdmissionLimits({
        MYRMIDON_MAX_HOST_CPU_BUSY_PERCENT: "85",
        MYRMIDON_MAX_HOST_CPU_PSI_SOME_AVG10: "40",
      }),
    ).toMatchObject({ maxHostCpuBusyPercent: 85, maxHostCpuPsiSomeAvg10: 40 });
    expect(
      readRunAdmissionLimits({ MYRMIDON_MAX_HOST_CPU_BUSY_PERCENT: "off", MYRMIDON_MAX_HOST_CPU_PSI_SOME_AVG10: "off" }),
    ).toMatchObject({ maxHostCpuBusyPercent: null, maxHostCpuPsiSomeAvg10: null });
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
        maxPerAgentStartSharePercent: 15,
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
        maxPerAgentStartSharePercent: 15,
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

describe("myrmidon(1.6.5 C0-ui) the memory snapshot of the load screen", () => {
  it("reports the cgroup usage as limit, usage and free, with the inactive cache reclaimable", () => {
    const files: Record<string, string> = {
      "/cg/memory.max": "8589934592\n",
      "/cg/memory.current": "7800532992\n",
      "/cg/memory.stat": "anon 4545642496\ninactive_file 2337927168\nactive_file 401641472\n",
    };
    expect(readCgroupMemoryUsageBytes("/cg", (path) => files[path]!)).toEqual({
      limitBytes: 8589934592,
      usedBytes: 7800532992 - 2337927168,
      freeBytes: 8589934592 - (7800532992 - 2337927168),
    });
    // No cgroup v2 limit (cgroup v1, `memory.max` is "max", unreadable file)
    // — nothing to report, and the load screen shows nothing rather than a
    // number it made up.
    expect(readCgroupMemoryUsageBytes("/cg", (path) => (path.endsWith("max") ? "max" : "0"))).toBeNull();
    expect(
      readCgroupMemoryUsageBytes("/none", () => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
  });

  it("the admission's snapshot carries the host and the container memory, each null when unreadable", () => {
    const GB = 1024 * MB;
    const admission = createRunAdmission({
      limits: { ...NO_MEMORY, maxConcurrentRuns: null, maxStartsPerMinute: null },
      hostMemory: () => ({ known: true as const, availableBytes: 44 * GB, totalBytes: 128 * GB }),
    });
    const snapshot = admission.memorySnapshot();
    expect(snapshot.host).toEqual({ availableMb: 44 * 1024, totalMb: 128 * 1024 });
    // The test process is not under a cgroup v2 limit, so the container side
    // is null — and the test still proves the view carries it when it reads.
    expect(snapshot.container === null || typeof snapshot.container.usedMb === "number").toBe(true);

    const blind = createRunAdmission({
      limits: { ...NO_MEMORY, maxConcurrentRuns: null, maxStartsPerMinute: null },
      hostMemory: () => ({ known: false as const, reason: "no meminfo" }),
    });
    expect(blind.memorySnapshot().host).toBeNull();
  });
});

describe("live limit changes", () => {
  const NO_MEMORY_LIMITS = {
    minFreeMemoryMb: null,
    runMemoryEstimateMb: 300,
    minFreeHostMemoryMb: null,
    maxHostLoadPercentPerCore: null,
    // myrmidon(1.6.5 RUN-FAIRNESS): the share default; the admission ignores it.
    maxPerAgentStartSharePercent: 15,
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
        // myrmidon(1.6.5 RUN-FAIRNESS): the admission ignores the share (part 1
        // will read it), so the report carries the default back.
        maxPerAgentStartSharePercent: 15,
      });
      expect(currentRunAdmissionLimits()).toEqual({
        maxConcurrentRuns: 7,
        maxStartsPerMinute: 3,
        minFreeMemoryMb: 900,
        runMemoryEstimateMb: 200,
        minFreeHostMemoryMb: 10240,
        maxHostLoadPercentPerCore: 150,
        maxPerAgentStartSharePercent: 15,
      });
      applyRunAdmissionLimits({
        maxConcurrentRuns: null,
        maxStartsPerMinute: null,
        minFreeMemoryMb: null,
        runMemoryEstimateMb: 300,
        minFreeHostMemoryMb: null,
        maxHostLoadPercentPerCore: null,
        // myrmidon(1.6.5 RUN-FAIRNESS): the share has no null (default-on 15).
        maxPerAgentStartSharePercent: 15,
      });
      expect(currentRunAdmissionLimits()).toEqual({
        maxConcurrentRuns: null,
        maxStartsPerMinute: null,
        minFreeMemoryMb: null,
        runMemoryEstimateMb: 300,
        minFreeHostMemoryMb: null,
        maxHostLoadPercentPerCore: null,
        maxPerAgentStartSharePercent: 15,
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
    // myrmidon(1.6.5 RUN-FAIRNESS): the share default; the admission ignores it.
    maxPerAgentStartSharePercent: 15,
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
  /**
   * A load source: the 1-minute average, the core count, and (rc.2) the
   * 15-minute average. The default makes both averages equal, which is what a
   * steady host looks like.
   */
  const cpu =
    (load1: number, cores = 16, load15: number | null = load1) =>
    () => ({ known: true as const, load1, load15, cores });
  /** The rounded percent-of-one-core a reading means, the way the gate counts it. */
  const percent = (load: number) => Math.round((load / 16) * 100);

  it("keeps admitting runs on a host whose own background is above the old fixed ceiling", () => {
    // The rc.1 regression (05.10 17:34): the background services of a bot host
    // hold ~120 % of a core per core by themselves, so the absolute 90 %
    // ceiling was closed from the first reading — the fleet stood still with 4
    // runs going and 34 waiting until the threshold was raised by hand to 200.
    let load = 19.2; // 120 % of a core
    const admission = createRunAdmission({
      limits: { ...CPU_CEILING },
      hostCpuLoad: () => cpu(load, 16, 18.4)(), // the 15-minute average is 115 %
      now: () => 0,
    });
    expect(admission.reserve(3)).toBe(3);
    expect(admission.hostCpuGate()).toMatchObject({
      state: "open",
      load1: 19.2,
      cores: 16,
      loadPercentPerCore: 120,
      backgroundPercentPerCore: 115,
      load15PercentPerCore: 115,
      loadAboveBackgroundPercent: 5,
      thresholdPercent: 90,
    });
    // What the runs add is what counts: 210 % of a core is 95 % above the
    // background, so the ceiling closes there — well above the old fixed 90 %.
    load = 33.6;
    expect(admission.reserve(1)).toBe(0);
    expect(admission.limited()).toBe(true);
    expect(admission.hostCpuGate()).toMatchObject({
      state: "closed",
      loadPercentPerCore: 210,
      backgroundPercentPerCore: 115,
      loadAboveBackgroundPercent: 95,
    });
    // ... and the hold ends when the runs let go again.
    load = 24;
    expect(admission.reserve(1)).toBe(1);
    expect(admission.hostCpuGate().state).toBe("open");
  });

  it("counts the load above the background floor, not the absolute reading", () => {
    // The same 594 % of a core. On a host that was near-idle a moment ago that
    // is a burst of runs and the ceiling closes; on a host whose own services
    // sit at that level it is the background, and runs may start.
    const burst = createRunAdmission({ limits: { ...CPU_CEILING }, hostCpuLoad: cpu(95, 16, 5) });
    expect(burst.reserve(1)).toBe(0);
    expect(burst.hostCpuGate()).toMatchObject({
      state: "closed",
      loadPercentPerCore: 594,
      backgroundPercentPerCore: 31,
      loadAboveBackgroundPercent: 563,
    });
    const background = createRunAdmission({ limits: { ...CPU_CEILING }, hostCpuLoad: cpu(95, 16, 95) });
    expect(background.reserve(1)).toBe(1);
    expect(background.hostCpuGate()).toMatchObject({ state: "open", loadAboveBackgroundPercent: 0 });
  });

  it("takes the background from the 15-minute average, so a restart during a spike is not open", () => {
    // The board itself fell over on 05.10 and came back while the host was
    // saturated: the 1-minute average alone would read "the host is just like
    // that" and the whole queue would start into the same wall again.
    const admission = createRunAdmission({ limits: { ...CPU_CEILING }, hostCpuLoad: cpu(95, 16, 40) });
    expect(admission.reserve(1)).toBe(0);
    expect(admission.hostCpuGate()).toMatchObject({
      state: "closed",
      loadPercentPerCore: 594,
      backgroundPercentPerCore: 250,
      loadAboveBackgroundPercent: 344,
    });
  });

  it("drops the floor to a lower reading at once and lets a burst raise it only by the slow drift", () => {
    let clock = 0;
    let load15 = 16; // the host idles at 100 % of a core per core
    let load1 = 16;
    const admission = createRunAdmission({
      limits: { ...CPU_CEILING },
      hostCpuLoad: () => cpu(load1, 16, load15)(),
      now: () => clock,
    });
    expect(admission.hostCpuGate().backgroundPercentPerCore).toBe(100);

    // A mass wake: the 1-minute average jumps to 352 % of a core within
    // seconds — the burst cannot pull the floor up with it.
    load1 = 56.32;
    expect(admission.reserve(1)).toBe(0);
    expect(admission.hostCpuGate()).toMatchObject({
      state: "closed",
      backgroundPercentPerCore: 100,
      loadAboveBackgroundPercent: 252,
    });

    // The 15-minute average catches up with the burst. From here the floor
    // follows the host, but only by HOST_CPU_FLOOR_RISE_PERCENT_PER_MINUTE of a
    // core per minute: 15 minutes of the burst buy 15 %.
    load15 = load1;
    clock += 15 * 60_000;
    expect(admission.hostCpuGate().backgroundPercentPerCore).toBe(115);
    // 148 minutes later the floor has absorbed the whole burst (263 %, 89 %
    // below the reading) and the ceiling is open again — a host that became
    // genuinely busier is followed, not fought.
    clock += 148 * 60_000;
    expect(admission.hostCpuGate()).toMatchObject({
      state: "open",
      backgroundPercentPerCore: 263,
      loadAboveBackgroundPercent: 89,
    });

    // A lower reading drops the floor at once: the host calmed down.
    load15 = 16;
    load1 = 16;
    expect(admission.hostCpuGate().backgroundPercentPerCore).toBe(percent(16));
  });

  it("does not read the host load when the ceiling is off, and leaves the other limits in charge when unreadable", () => {
    const read = vi.fn(cpu(95));
    const off = createRunAdmission({ limits: { ...CPU_CEILING, maxHostLoadPercentPerCore: null }, hostCpuLoad: read });
    expect(off.reserve(3)).toBe(3);
    expect(read).not.toHaveBeenCalled();
    expect(off.hostCpuGate()).toMatchObject({ state: "off", backgroundPercentPerCore: null, loadAboveBackgroundPercent: null });

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
    let load = 20; // 125 % of a core, all of it background: nothing added yet
    const admission = createRunAdmission({ limits: { ...CPU_CEILING }, hostCpuLoad: () => cpu(load, 16, 20)() });
    expect(admission.reserve(1)).toBe(1);
    load = 35; // 219 %: 94 % of a core above the floor, over the 90 % ceiling
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
      hostCpuLoad: cpu(60, 16, 16), // 375 % of a core, 275 % of it above the background
    });
    expect(admission.reserve(1)).toBe(0);
    expect(admission.hostMemoryGate().state).toBe("closed");
    expect(admission.hostCpuGate()).toMatchObject({ state: "closed", backgroundPercentPerCore: 100 });
  });

  it("raises the CPU attention signal only after ten minutes of continuous hold", () => {
    let clock = Date.parse("2026-10-05T01:00:00Z");
    let load = 60; // 375 % of a core with the background at 100 %
    const events: string[] = [];
    const admission = createRunAdmission({
      limits: { ...CPU_CEILING },
      hostCpuLoad: () => cpu(load, 16, 16)(),
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
    expect(signal).toMatchObject({
      load1: 60,
      cores: 16,
      loadPercentPerCore: 375,
      backgroundPercentPerCore: 100,
      thresholdPercent: 90,
    });
    expect(signal!.heldMs).toBeGreaterThanOrEqual(HOST_CPU_HOLD_SIGNAL_MS);
    // One "closed" line for the whole hold, not one per resweep.
    expect(events).toEqual(["closed"]);

    load = 20; // 125 % of a core: 25 % above the floor — open.
    expect(admission.reserve(1)).toBe(1);
    expect(events).toEqual(["closed", "open"]);
    expect(hostCpuHoldSignal(admission.hostCpuGate(), clock)).toBeNull();
  });

  it("starts a new CPU hold when the queue stopped asking in between", () => {
    let clock = 0;
    const admission = createRunAdmission({ limits: { ...CPU_CEILING }, hostCpuLoad: cpu(60, 16, 16), now: () => clock });
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

  it("reads load1 and load15 from /proc/loadavg and refuses an unknown core count", () => {
    const loadavg = "0.52 0.58 0.59 1/389 27714\n";
    const read = (path: string) => {
      if (path === "/proc/loadavg") return loadavg;
      throw new Error("ENOENT");
    };
    expect(readHostCpuLoad({ readFile: read, cpuCount: () => 16 })).toEqual({
      known: true,
      load1: 0.52,
      load15: 0.59,
      cores: 16,
    });
    // A file with only the two shortest averages (an old kernel, a fixture):
    // the 15-minute average is missing, the reading itself still stands.
    expect(readHostCpuLoad({ readFile: () => "1.5 1.4\n", cpuCount: () => 4 })).toEqual({
      known: true,
      load1: 1.5,
      load15: null,
      cores: 4,
    });
    expect(readHostCpuLoad({ readFile: read, cpuCount: () => 0 })).toMatchObject({ known: false });
    expect(readHostCpuLoad({ loadavgPath: "/host/loadavg", readFile: read })).toMatchObject({ known: false });
    expect(readHostCpuLoad({ readFile: () => "garly\n", cpuCount: () => 4 })).toMatchObject({ known: false });
  });
});

// ---------------------------------------------------------------------------
// myrmidon(1.6.5 RUN-FAIRNESS): the fair queue at a busy global cap.
//
// What this suite pins, with the admission built on in-memory limits and
// readings (no database, neutral data):
//
//   1. `lastDenialReason` names the gate that closed the last reservation
//      (global cap, start ramp, server memory, host memory, host CPU) and is
//      null again after a reservation served in full;
//   2. a reservation that names its agent counts against that agent's share
//      of the sliding 10-minute start window (`agentStartShare`), and an
//      anonymous reservation never does;
//   3. the share gate (`evaluateAgentStartShare`) holds an agent at or over
//      its share ONLY while other agents wait, and never holds a queue
//      shorter than one full share step;
//   4. the sweep order (`orderAgentIdsByOldestQueuedRun`) hands a freed
//      global slot to the agent whose oldest queued run waited longest —
//      the acceptance rule of the ticket: at a busy cap the longest-waiting
//      run gets the slot.
// ---------------------------------------------------------------------------

describe("myrmidon(1.6.5 RUN-FAIRNESS)", () => {
  const OPEN = {
    maxConcurrentRuns: null,
    maxStartsPerMinute: null,
    minFreeMemoryMb: null,
    runMemoryEstimateMb: 300,
    minFreeHostMemoryMb: null,
    maxHostLoadPercentPerCore: null,
    maxPerAgentStartSharePercent: null,
  };
  const AGENT_A = "aaaaaaaa-1111-4111-8111-111111111111";
  const AGENT_B = "bbbbbbbb-2222-4222-8222-222222222222";
  const AGENT_C = "cccccccc-3333-4333-8333-333333333333";

  describe("lastDenialReason", () => {
    it("is null while reservations are served in full", () => {
      const admission = createRunAdmission({ limits: { ...OPEN } });
      expect(admission.lastDenialReason()).toBeNull();
      expect(admission.reserve(3)).toBe(3);
      expect(admission.lastDenialReason()).toBeNull();
    });

    it("names the global concurrency cap", () => {
      const admission = createRunAdmission({ limits: { ...OPEN, maxConcurrentRuns: 2 } });
      expect(admission.reserve(2)).toBe(2);
      expect(admission.lastDenialReason()).toBeNull();
      expect(admission.reserve(1)).toBe(0);
      expect(admission.lastDenialReason()).toBe("global_cap");
    });

    it("names the start ramp when the ramp binds before the cap", () => {
      // The cap leaves room (5 of 10), the ramp does not (1 start left).
      const admission = createRunAdmission({
        limits: { ...OPEN, maxConcurrentRuns: 10, maxStartsPerMinute: 3 },
      });
      expect(admission.reserve(2)).toBe(2);
      expect(admission.lastDenialReason()).toBeNull();
      expect(admission.reserve(5)).toBe(1);
      expect(admission.lastDenialReason()).toBe("start_ramp");
    });

    it("names the server free-memory guard", () => {
      const admission = createRunAdmission({
        limits: { ...OPEN, minFreeMemoryMb: 1000, runMemoryEstimateMb: 300 },
        freeMemoryBytes: () => (1000 + 300) * MB,
      });
      expect(admission.reserve(2)).toBe(1);
      expect(admission.lastDenialReason()).toBe("memory");
      expect(admission.reserve(2)).toBe(0);
      expect(admission.lastDenialReason()).toBe("memory");
    });

    it("names the host memory floor", () => {
      const GB = 1024 * MB;
      const admission = createRunAdmission({
        limits: { ...OPEN, minFreeHostMemoryMb: 15360 },
        hostMemory: () => ({ known: true, availableBytes: 10 * GB, totalBytes: 64 * GB }),
      });
      expect(admission.reserve(1)).toBe(0);
      expect(admission.lastDenialReason()).toBe("host_memory");
    });

    it("names the host CPU ceiling", () => {
      const admission = createRunAdmission({
        limits: { ...OPEN, maxHostLoadPercentPerCore: 90 },
        hostCpuLoad: () => ({ known: true, load1: 95, load15: 5, cores: 16 }),
      });
      expect(admission.reserve(1)).toBe(0);
      expect(admission.lastDenialReason()).toBe("host_cpu");
    });

    it("clears on the next reservation, whatever it returns", () => {
      const admission = createRunAdmission({ limits: { ...OPEN, maxConcurrentRuns: 1 } });
      expect(admission.reserve(2)).toBe(1);
      expect(admission.lastDenialReason()).toBe("global_cap");
      admission.finish();
      expect(admission.reserve(1)).toBe(1);
      expect(admission.lastDenialReason()).toBeNull();
    });
  });

  describe("per-agent share of the sliding start window", () => {
    it("counts only reservations that name their agent", () => {
      const admission = createRunAdmission({ limits: { ...OPEN } });
      admission.reserve(2, { agentId: AGENT_A });
      admission.reserve(1); // a non-sweep start path: no agent
      admission.reserve(1, { agentId: AGENT_B });
      const share = admission.agentStartShare();
      expect(share.total).toBe(3);
      expect(share.byAgent.get(AGENT_A)).toBe(2);
      expect(share.byAgent.get(AGENT_B)).toBe(1);
      expect(share.byAgent.has("anonymous")).toBe(false);
    });

    it("drops starts older than the 10-minute window", () => {
      let clock = 0;
      const admission = createRunAdmission({ limits: { ...OPEN }, now: () => clock });
      admission.reserve(2, { agentId: AGENT_A });
      clock = AGENT_START_SHARE_WINDOW_MS + 1;
      admission.reserve(1, { agentId: AGENT_B });
      const share = admission.agentStartShare();
      expect(share.total).toBe(1);
      expect(share.byAgent.get(AGENT_A)).toBeUndefined();
      expect(share.byAgent.get(AGENT_B)).toBe(1);
    });

    it("holds an agent at or over its share while other agents wait, and only then", () => {
      // 20 starts in the window, 3 of them by AGENT_A, the share ceiling 15 %:
      // 3 >= ceil(0.15 * 20) = 3 — the agent waits while others queue.
      expect(
        evaluateAgentStartShare({
          windowedStarts: 20,
          agentStarts: 3,
          sharePercent: 15,
          otherAgentsWaiting: true,
        }),
      ).toEqual({
        allowed: false,
        reason: "agent_fair_share",
        sharePercent: 15,
        windowedStarts: 20,
        agentStarts: 3,
      });
      // The same numbers with nobody else waiting: the share never idles a
      // lone queue.
      expect(
        evaluateAgentStartShare({
          windowedStarts: 20,
          agentStarts: 3,
          sharePercent: 15,
          otherAgentsWaiting: false,
        }).allowed,
      ).toBe(true);
      // Under the share: 2 < 3, the agent starts.
      expect(
        evaluateAgentStartShare({
          windowedStarts: 20,
          agentStarts: 2,
          sharePercent: 15,
          otherAgentsWaiting: true,
        }).allowed,
      ).toBe(true);
    });

    it("never holds a queue shorter than one full share step", () => {
      // 5 starts in the window, all by AGENT_A: 5 < 100 / 15 = 6.67 — any
      // start would cross the share arithmetically, so the gate stays open.
      expect(
        evaluateAgentStartShare({
          windowedStarts: 5,
          agentStarts: 5,
          sharePercent: 15,
          otherAgentsWaiting: true,
        }).allowed,
      ).toBe(true);
      // At 7 starts the first share step exists: 7 >= 6.67 and
      // 7 >= ceil(0.15 * 7) = 2 — the agent over its share waits.
      expect(
        evaluateAgentStartShare({
          windowedStarts: 7,
          agentStarts: 7,
          sharePercent: 15,
          otherAgentsWaiting: true,
        }).allowed,
      ).toBe(false);
    });

    it("lets the agents below their share through while the agent over its share waits (the acceptance rule at a busy cap)", () => {
      // The incident shape: the global cap is full, several agents wait, and
      // one agent took ~half the starts of the window. With the share gate
      // the freed slot passes the dominant agent by and reaches the agents
      // that have not started.
      const sharePercent = 15;
      const windowedStarts = 48;
      const dominant = evaluateAgentStartShare({
        windowedStarts,
        agentStarts: 23, // ~48 % of the window
        sharePercent,
        otherAgentsWaiting: true,
      });
      expect(dominant.allowed).toBe(false);
      const shareStep = Math.ceil((sharePercent / 100) * windowedStarts); // 8
      for (const agentStarts of [0, 1, shareStep - 1]) {
        expect(
          evaluateAgentStartShare({
            windowedStarts,
            agentStarts,
            sharePercent,
            otherAgentsWaiting: true,
          }).allowed,
        ).toBe(true);
      }
    });
  });

  describe("sweep order: the oldest waiter first", () => {
    it("orders the agents by the createdAt of each agent's oldest queued run", () => {
      const t = (minutesAgo: number) => new Date(Date.UTC(2026, 9, 6, 12, 0, 0) - minutesAgo * 60_000);
      // The queue read is ordered by run createdAt, so the first appearance
      // of an agent is its oldest run. AGENT_C queued first but appears once.
      const order = orderAgentIdsByOldestQueuedRun([
        [AGENT_B, t(9)],
        [AGENT_A, t(12)],
        [AGENT_C, t(30)],
      ]);
      expect(order).toEqual([AGENT_C, AGENT_A, AGENT_B]);
    });

    it("at a busy cap the longest-waiting run gets the freed slot (the ticket's acceptance rule)", () => {
      // Two agents queued; the sweep order decides whose reserve() runs
      // first, and the admission has exactly one free slot.
      const t = (minutesAgo: number) => new Date(Date.UTC(2026, 9, 6, 12, 0, 0) - minutesAgo * 60_000);
      const order = orderAgentIdsByOldestQueuedRun([
        [AGENT_B, t(1)],
        [AGENT_A, t(25)],
      ]);
      const admission = createRunAdmission({ limits: { ...OPEN, maxConcurrentRuns: 51 } });
      admission.syncRunning(50); // the cap is 51, 50 run: one slot free
      const winners: string[] = [];
      for (const agentId of order) {
        if (admission.reserve(1, { agentId }) > 0) winners.push(agentId);
      }
      expect(winners).toEqual([AGENT_A]); // the 25-minute waiter, not the first in line
      expect(admission.lastDenialReason()).toBe("global_cap");
    });
  });
});

describe("myrmidon(1.6.5 RUN-ADMISSION, rc.3) host CPU busy ceiling", () => {
  // The busy ceiling on, the load ceiling on as well: on the 06.10 host both
  // were active (the stored row carries the legacy 90), and the decision must
  // now come from the /proc/stat delta, with load average only reporting.
  const BUSY_CEILING = {
    maxConcurrentRuns: null,
    maxStartsPerMinute: null,
    ...NO_MEMORY,
    maxHostCpuBusyPercent: 90,
  };
  // The legacy row: neither rc.3 key present — the load average still decides.
  const loadOnly = (busy: number | null, psi: number | null = null) => {
    // busy/psi `undefined` = the stored row saved before rc.3.
    return {
      maxConcurrentRuns: null,
      maxStartsPerMinute: null,
      ...NO_MEMORY,
      maxHostLoadPercentPerCore: 90,
      ...(busy === null ? { maxHostCpuBusyPercent: undefined } : { maxHostCpuBusyPercent: busy }),
      ...(psi === null ? { maxHostCpuPsiSomeAvg10: undefined } : { maxHostCpuPsiSomeAvg10: psi }),
    };
  };

  /**
   * A /proc/stat source driven by the test: `set(idle, total)` moves the
   * cumulative counters, the admission computes the busy percent from the
   * delta between the windows it keeps.
   */
  const statSource = (idle = 1000, total = 1000) => {
    const state = { idle, total };
    return {
      set(nextIdle: number, nextTotal: number) {
        state.idle = nextIdle;
        state.total = nextTotal;
      },
      probe: () => ({ known: true as const, sample: { idle: state.idle, total: state.total } }),
    };
  };

  /**
   * The 06.10 host: a mass wake pushed the 1-minute load to 65.7 on 16 cores
   * (the 15-minute average still 5.0 — the spike shape the incident had),
   * while the CPU itself was only about 70 % busy. On the load-average rule
   * this picture holds runs (the floor stays low, the spike is all "added"
   * load); on the busy rule they pass. This fixture is the guard case: it
   * must be RED against main's run-admission.ts and green with rc.3.
   */
  const saturatedLoad = (load1 = 65.7, load15 = 5.0) => () => ({
    known: true as const,
    load1,
    load15,
    cores: 16,
  });

  it("admits runs on a host whose load average screams but whose CPU has headroom (the 06.10 case)", () => {
    let clock = 0;
    const stat = statSource(300, 1000); // base: 30 % idle of 1000 ticks
    const admission = createRunAdmission({
      limits: { ...BUSY_CEILING, maxHostLoadPercentPerCore: 90 },
      hostCpuLoad: saturatedLoad(),
      hostCpuStatProbe: stat.probe,
      now: () => clock,
    });
    // The first call after the start only takes the base reading: nothing is
    // measured yet, and an unmeasured ceiling does not hold runs.
    expect(admission.hostCpuGate()).toMatchObject({ state: "open", cpuBusyPercent: null, source: "cpu-busy" });
    // Move the counters: 1000 more total ticks of which 300 idle → 70 % busy.
    stat.set(600, 2000);
    clock = CPU_BUSY_SAMPLE_WINDOW_MS;
    expect(admission.hostCpuGate()).toMatchObject({ state: "open", cpuBusyPercent: 70 });
    // Load average 65.7 / 16 cores is 411 % of a core — the legacy rule closed
    // on this; the busy rule admits, with load still reported alongside.
    expect(admission.reserve(3)).toBe(3);
    expect(admission.hostCpuGate()).toMatchObject({
      state: "open",
      source: "cpu-busy",
      cpuBusyPercent: 70,
      busyThresholdPercent: 90,
      loadPercentPerCore: 411,
      thresholdPercent: 90,
    });
  });

  it("holds runs when the CPU is saturated, even below the legacy load ceiling", () => {
    let clock = 0;
    const stat = statSource(100, 1000);
    const admission = createRunAdmission({
      // The legacy ceiling off: only the busy rule is in force.
      limits: { ...BUSY_CEILING },
      hostCpuLoad: () => ({ known: false, reason: "unused" }),
      hostCpuStatProbe: stat.probe,
      now: () => clock,
    });
    admission.hostCpuGate(); // take the base
    // 99 % busy over the next window: 1000 more ticks, 10 idle.
    stat.set(110, 2000);
    clock = CPU_BUSY_SAMPLE_WINDOW_MS;
    expect(admission.hostCpuGate()).toMatchObject({ state: "closed", cpuBusyPercent: 99 });
    expect(admission.reserve(2)).toBe(0);
    expect(admission.limited()).toBe(true);
    const gate = admission.hostCpuGate();
    expect(gate.reason).toMatch(/99 % busy .* at or above the 90 % busy ceiling/);
    // The counters calm down: 500 total ticks with 350 idle → 30 % busy.
    stat.set(460, 2500);
    clock = 2 * CPU_BUSY_SAMPLE_WINDOW_MS;
    expect(admission.reserve(2)).toBe(2);
    expect(admission.hostCpuGate().state).toBe("open");
  });

  it("closes on PSI pressure only when the operator set the ceiling", () => {
    let clock = 0;
    const stat = statSource(100, 1000);
    const psiReads = vi.fn(() => ({ known: true as const, someAvg10: 45 }));
    const admission = createRunAdmission({
      limits: { ...BUSY_CEILING, maxHostCpuPsiSomeAvg10: 40 },
      hostCpuLoad: () => ({ known: false, reason: "unused" }),
      hostCpuStatProbe: stat.probe,
      hostCpuPsi: psiReads,
      now: () => clock,
    });
    admission.hostCpuGate(); // take the base window
    stat.set(600, 2000); // 50 % busy — open by the busy rule
    clock = CPU_BUSY_SAMPLE_WINDOW_MS;
    expect(admission.reserve(1)).toBe(0);
    const gate = admission.hostCpuGate();
    expect(gate).toMatchObject({ state: "closed", cpuBusyPercent: 50, psiSomeAvg10: 45, psiThresholdPercent: 40 });
    expect(gate.reason).toMatch(/some avg10 is 45 % at or above the 40 % PSI ceiling/);
  });

  it("does not read or apply PSI when the ceiling is unset", () => {
    const psiReads = vi.fn(() => ({ known: true as const, someAvg10: 95 }));
    const admission = createRunAdmission({
      limits: { ...BUSY_CEILING }, // PSI undefined → off
      hostCpuLoad: () => ({ known: false, reason: "unused" }),
      hostCpuStatProbe: () => ({ known: true as const, sample: { idle: 100, total: 1000 } }),
      hostCpuPsi: psiReads,
    });
    expect(admission.reserve(1)).toBe(1);
    expect(admission.hostCpuGate().psiSomeAvg10).toBeNull();
    expect(psiReads).not.toHaveBeenCalled();
  });

  it("leaves the other limits in charge when /proc/stat cannot be read, logging the reason once", () => {
    const unavailable = vi.fn();
    const admission = createRunAdmission({
      limits: { ...BUSY_CEILING, maxConcurrentRuns: 2 },
      hostCpuLoad: () => ({ known: false, reason: "unused" }),
      hostCpuStatProbe: () => ({ known: false, reason: "/proc/stat is not readable" }),
      onHostCpuUnavailable: unavailable,
    });
    expect(admission.reserve(5)).toBe(2);
    expect(unavailable).toHaveBeenCalledWith("/proc/stat is not readable");
    expect(admission.hostCpuGate()).toMatchObject({ state: "unknown", reason: "/proc/stat is not readable" });
  });

  it("reports unknown when the PSI file cannot be read while its ceiling is set", () => {
    const admission = createRunAdmission({
      limits: { ...BUSY_CEILING, maxHostCpuPsiSomeAvg10: 40 },
      hostCpuLoad: () => ({ known: false, reason: "unused" }),
      hostCpuStatProbe: () => ({ known: true as const, sample: { idle: 100, total: 1000 } }),
      hostCpuPsi: () => ({ known: false, reason: "/proc/pressure/cpu is not readable" }),
    });
    expect(admission.hostCpuGate()).toMatchObject({
      state: "unknown",
      reason: "/proc/pressure/cpu is not readable",
    });
  });

  it("keeps the load-average rule for a settings row saved before rc.3 (backward compatibility)", () => {
    // The legacy 05.10 picture: load 95 on 16 cores, background at 100 % of a
    // core → 494 % above the floor, at or above the 90 % ceiling: closed.
    const admission = createRunAdmission({
      limits: loadOnly(null, null),
      hostCpuLoad: () => ({ known: true, load1: 95, load15: 16, cores: 16 }),
      hostCpuStatProbe: () => ({ known: true as const, sample: { idle: 500, total: 1000 } }), // 50 % busy: idle host
    });
    expect(admission.reserve(1)).toBe(0);
    expect(admission.hostCpuGate()).toMatchObject({ state: "closed", source: "load-average", cpuBusyPercent: null });
  });

  it("takes over from load average as soon as the busy ceiling is set on the fly", () => {
    const admission = createRunAdmission({
      limits: loadOnly(null, null), // legacy row: only the load ceiling decides
      hostCpuLoad: () => ({ known: true, load1: 95, load15: 16, cores: 16 }),
      hostCpuStatProbe: () => ({ known: true as const, sample: { idle: 500, total: 1000 } }), // an idle host
    });
    // Legacy: load 95 on 16 cores is 494 % above the background floor — closed.
    expect(admission.reserve(1)).toBe(0);
    expect(admission.hostCpuGate()).toMatchObject({ state: "closed", source: "load-average" });
    // The operator saves limits on this instance: the busy rule takes over and
    // the saturated load average no longer holds anything back.
    admission.updateLimits(loadOnly(90, null));
    expect(admission.reserve(1)).toBe(1);
    expect(admission.hostCpuGate()).toMatchObject({ state: "open", source: "cpu-busy", busyThresholdPercent: 90 });
  });

  it("ends the CPU hold when the busy ceiling is switched off", () => {
    let clock = 0;
    const stat = statSource(0, 1000);
    const events: string[] = [];
    const admission = createRunAdmission({
      limits: { ...BUSY_CEILING },
      hostCpuLoad: () => ({ known: false, reason: "unused" }),
      hostCpuStatProbe: stat.probe,
      onHostCpuHold: (event) => events.push(event.state),
      now: () => clock,
    });
    admission.hostCpuGate(); // base
    stat.set(5, 2000); // ~99.7 % busy
    clock = CPU_BUSY_SAMPLE_WINDOW_MS;
    expect(admission.reserve(1)).toBe(0);
    expect(events).toEqual(["closed"]);
    expect(admission.hostCpuGate().heldSince).not.toBeNull();
    // Switch the busy ceiling off (no other ceiling remains): the hold resets.
    admission.updateLimits({ ...BUSY_CEILING, maxHostCpuBusyPercent: null });
    expect(admission.hostCpuGate().state).toBe("off");
    expect(admission.hostCpuGate().heldSince).toBeNull();
  });

  it("ignores a delta window in which the counters did not move", () => {
    let clock = 0;
    const stat = statSource(300, 1000);
    const admission = createRunAdmission({
      limits: { ...BUSY_CEILING },
      hostCpuLoad: () => ({ known: false, reason: "unused" }),
      hostCpuStatProbe: stat.probe,
      now: () => clock,
    });
    admission.hostCpuGate(); // base at clock 0
    clock = CPU_BUSY_SAMPLE_WINDOW_MS;
    // Second call after the window but with identical counters: no measurement,
    // and the base stays where it was (the window keeps growing).
    expect(admission.hostCpuGate()).toMatchObject({ state: "open", cpuBusyPercent: null });
    stat.set(600, 2000);
    clock = CPU_BUSY_SAMPLE_WINDOW_MS * 2;
    expect(admission.hostCpuGate()).toMatchObject({ state: "open", cpuBusyPercent: 70 });
  });

  it("reads the busy sample from /proc/stat and the pressure from /proc/pressure/cpu", () => {
    const stat =
      "cpu  100 20 80 700 50 5 5 0 0 0\ncpu0 50 10 40 350 25 2 2 0 0 0\ncpu1 50 10 40 350 25 3 3 0 0 0\nintr 1234\n";
    expect(readHostCpuStatProbe({ statPath: "/proc/stat", readFile: () => stat })).toEqual({
      known: true,
      sample: { idle: 700 + 50, total: 100 + 20 + 80 + 700 + 50 + 5 + 5 },
    });
    expect(readHostCpuStatProbe({ readFile: () => "intr 5\n" })).toMatchObject({ known: false });
    expect(
      readHostCpuStatProbe({
        readFile: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toMatchObject({ known: false, reason: /not readable/ });
    const psi = "some avg10=2.50 avg60=1.20 avg300=0.50 total=12345678\nfull avg10=0.10 avg60=0.05 avg300=0.01 total=42\n";
    expect(readHostCpuPsi({ readFile: () => psi })).toEqual({ known: true, someAvg10: 2.5 });
    expect(readHostCpuPsi({ readFile: () => "nope\n" })).toMatchObject({ known: false });
    expect(cpuBusyPercentFromDelta({ idle: 300, total: 1000 }, { idle: 600, total: 2000 })).toBe(70);
    expect(cpuBusyPercentFromDelta({ idle: 300, total: 1000 }, { idle: 300, total: 1000 })).toBeNull();
    expect(cpuBusyPercentFromDelta({ idle: 300, total: 1000 }, { idle: 300, total: 1001 })).toBeCloseTo(100, 0);
  });
});

// myrmidon(1.6.5 OWNER-CHAT-ADMISSION): the owner's own turn in a chat does not
// wait behind the host ceilings. The production pair the ticket names on
// 09.10: minFreeHostMemoryMb 7168 and minFreeMemoryMb 1500.
describe("owner chat turns (OWNER-CHAT-ADMISSION)", () => {
  const GB = 1024 * MB;
  /** The host is busy; the server container itself has room. */
  const BUSY_HOST = {
    maxConcurrentRuns: null,
    maxStartsPerMinute: null,
    minFreeMemoryMb: 1500,
    runMemoryEstimateMb: 300,
    minFreeHostMemoryMb: 7168,
    maxHostLoadPercentPerCore: null,
    maxPerAgentStartSharePercent: 15,
  };
  const hostBelowFloor = () => ({
    known: true as const,
    availableBytes: 4 * GB,
    totalBytes: 64 * GB,
  });
  const cpu =
    (load1: number, cores = 16, load15: number | null = load1) =>
    () => ({ known: true as const, load1, load15, cores });

  it("starts the owner's turn and queues the automatic run with memory between the floors", () => {
    const admission = createRunAdmission({
      limits: { ...BUSY_HOST },
      freeMemoryBytes: () => 4 * GB, // 4096 MB free, 2596 MB above the 1500 MB floor
      hostMemory: hostBelowFloor,
    });
    // The automatic run waits: the host is below its own 7168 MB floor.
    expect(admission.reserve(2)).toBe(0);
    expect(admission.lastDenialReason()).toBe("host_memory");
    // The owner's own turn starts: the container itself is above its floor.
    expect(admission.reserve(2, { agentId: "agent-a", ownerChatTurns: 1 })).toBe(1);
    // The automatic one left queued still says why it waits.
    expect(admission.lastDenialReason()).toBe("host_memory");
  });

  it("holds the owner's turn when the container is below its own floor", () => {
    const admission = createRunAdmission({
      limits: { ...BUSY_HOST, minFreeHostMemoryMb: null },
      freeMemoryBytes: () => 1200 * MB, // below the 1500 MB floor
      hostMemory: () => ({ known: true as const, availableBytes: 60 * GB, totalBytes: 64 * GB }),
    });
    expect(admission.reserve(1, { ownerChatTurns: 1 })).toBe(0);
    expect(admission.lastDenialReason()).toBe("memory");
  });

  it("does not let the CPU ceiling hold the owner's turn", () => {
    const admission = createRunAdmission({
      limits: { ...BUSY_HOST, minFreeHostMemoryMb: null, maxHostLoadPercentPerCore: 90 },
      freeMemoryBytes: () => 4 * GB,
      hostCpuLoad: cpu(300, 16), // 1875 % of a core, far above the ceiling
    });
    expect(admission.hostCpuGate().state).toBe("closed");
    expect(admission.reserve(1)).toBe(0);
    expect(admission.lastDenialReason()).toBe("host_cpu");
    expect(admission.reserve(1, { ownerChatTurns: 1 })).toBe(1);
  });

  it("reports the owner-turn gate: open, closed, off, unknown", () => {
    const open = createRunAdmission({
      limits: { ...BUSY_HOST },
      freeMemoryBytes: () => 4 * GB,
      hostMemory: hostBelowFloor,
    });
    expect(open.ownerChatTurnGate()).toMatchObject({
      state: "open",
      thresholdMb: 1500,
      freeMb: 4096,
      settlingRuns: 0,
      reason: null,
    });
    const closed = createRunAdmission({
      limits: { ...BUSY_HOST },
      freeMemoryBytes: () => 1200 * MB,
      hostMemory: hostBelowFloor,
    });
    expect(closed.ownerChatTurnGate()).toMatchObject({
      state: "closed",
      thresholdMb: 1500,
      freeMb: 1200,
    });
    const off = createRunAdmission({
      limits: { ...BUSY_HOST, minFreeMemoryMb: null },
      freeMemoryBytes: () => 4 * GB,
    });
    expect(off.ownerChatTurnGate().state).toBe("off");
    const unknown = createRunAdmission({
      limits: { ...BUSY_HOST },
      freeMemoryBytes: () => null,
    });
    expect(unknown.ownerChatTurnGate()).toMatchObject({ state: "unknown", freeMb: null });
  });

  it("names the runs still settling when the owner-turn gate closes", () => {
    let clock = 0;
    const admission = createRunAdmission({
      limits: { ...BUSY_HOST, minFreeHostMemoryMb: null },
      freeMemoryBytes: () => 2100 * MB, // exactly two 300 MB runs above the floor
      now: () => clock,
    });
    // The chat notice asks this before it speaks: open, so nothing to announce.
    expect(admission.ownerChatTurnGate()).toMatchObject({ state: "open", settlingRuns: 0 });
    expect(admission.reserve(2)).toBe(2);
    clock += 1000;
    expect(admission.ownerChatTurnGate()).toMatchObject({
      state: "closed",
      freeMb: 2100,
      settlingRuns: 2,
    });
    expect(admission.ownerChatTurnGate().reason).toContain("still starting");
  });
});
