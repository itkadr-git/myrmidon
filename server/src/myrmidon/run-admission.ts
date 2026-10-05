import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import {
  RUN_LIMITS_ENV_KEYS,
  readRunLimitsFromEnv,
  type RunLimits,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

/**
 * Instance-wide run admission (myrmidon, stage 0 of per-project containers).
 *
 * The vendor limits concurrent runs per agent only. With local adapters every
 * run is a child process of the server container, so a mass wake of many agents
 * (35 hermes processes on 2026-09-28) exhausts the container memory and the
 * kernel kills the server together with every run. Admission adds instance-wide
 * limits on top of the per-agent one:
 *
 * - MYRMIDON_MAX_CONCURRENT_RUNS: at most N runs started by this process at once;
 * - MYRMIDON_MAX_RUN_STARTS_PER_MINUTE: at most K run starts per sliding minute,
 *   so a restart or a bulk resolve does not start everything in one burst;
 * - MYRMIDON_MIN_FREE_MEMORY_MB: follow the server load. A run starts only if the
 *   server container keeps this much memory free after it; each run is budgeted
 *   at MYRMIDON_RUN_MEMORY_ESTIMATE_MB (default 300). Free memory is the cgroup
 *   limit minus usage without reclaimable inactive page cache.
 *
 * Runs over a limit stay `queued`; the periodic queued-run sweep starts them
 * when a slot frees. Unset, empty or 0 disables a limit. When
 * MYRMIDON_MIN_FREE_MEMORY_MB is set but this process cannot read its cgroup
 * limit (memory.max is 'max', cgroup v1, not in a container), the memory guard
 * is inactive and that is logged once, so an operator does not read a silent
 * pass as a working guard (myrmidon(C0)).
 *
 * myrmidon(1.6.2 RUN-ADMISSION): the server cgroup does not see the bots. A
 * bot runs in its own container (4 GB limit each), so 23 concurrent runs filled
 * the HOST (04.10: MemAvailable 7 GB, swap full, a global OOM restarted 40
 * containers) while the server cgroup looked healthy. Two more limits apply to
 * every new run, whatever woke it (on_demand, assignment, idle-pickup, swarm
 * idle wake, automation), because every one of them starts through `reserve`:
 *
 * - MYRMIDON_MIN_FREE_HOST_MEMORY_MB (default 15360): a run starts only while
 *   the host's MemAvailable, minus the budget of runs started in the last 30 s,
 *   stays at or above this floor. Host memory is read from /proc/meminfo: a
 *   Docker container without lxcfs sees the host's meminfo there (the kernel
 *   does not namespace it), so the board needs no mount and no Docker API call.
 *   When /proc/meminfo is scoped to the container (lxcfs: MemTotal equals the
 *   cgroup limit) the reading is refused as "unknown"; mount the host file and
 *   point MYRMIDON_HOST_MEMINFO_PATH at it.
 * - MYRMIDON_MAX_RUN_STARTS_PER_MINUTE now defaults to 5 (the start ramp): a
 *   bot's memory grows after its run starts, so starts are spread over time
 *   instead of all passing one reading of free memory.
 *
 * A run held by the host floor stays `queued` and the 15 s resweep retries it.
 * The admission remembers since when the floor has held runs back; after 10
 * minutes `hostMemoryHoldSignal` returns an attention signal.
 *
 * myrmidon(1.6.5 RUN-ADMISSION): memory alone did not save the night of 05.10
 * — 43+ runs started at once while the memory floor stayed open, the host ran
 * load average 95 on 16 cores (594 % of a core per core), and the board's own
 * API answered 3+ s until it fell over on timeouts. A saturated CPU queue is
 * invisible to every memory reading, so `reserve` also refuses a new run while
 * the host's 1-minute load average per core is at or above
 * MYRMIDON_MAX_HOST_LOAD_PERCENT_PER_CORE (default 90, `0`/`off` switches the
 * ceiling off; changeable on the fly like the other run limits). The load is
 * the host's: /proc/loadavg and the visible CPU count are not namespaced by
 * Docker. The hold is tracked exactly like the host memory hold — the run
 * stays `queued`, the 15 s resweep retries it, and after 10 minutes
 * `hostCpuHoldSignal` returns an attention signal.
 *
 * No locks: the server is one Node.js thread, and `reserve` checks and counts
 * without awaiting anything, so two agents cannot both take the last slot.
 */

export const MAX_CONCURRENT_RUNS_ENV = RUN_LIMITS_ENV_KEYS.maxConcurrentRuns;
export const MAX_RUN_STARTS_PER_MINUTE_ENV = RUN_LIMITS_ENV_KEYS.maxStartsPerMinute;
export const MIN_FREE_MEMORY_MB_ENV = RUN_LIMITS_ENV_KEYS.minFreeMemoryMb;
export const RUN_MEMORY_ESTIMATE_MB_ENV = RUN_LIMITS_ENV_KEYS.runMemoryEstimateMb;
export const MIN_FREE_HOST_MEMORY_MB_ENV = RUN_LIMITS_ENV_KEYS.minFreeHostMemoryMb;
// myrmidon(1.6.5 RUN-ADMISSION): the host CPU ceiling.
export const MAX_HOST_LOAD_PERCENT_PER_CORE_ENV = RUN_LIMITS_ENV_KEYS.maxHostLoadPercentPerCore;
/** myrmidon(1.6.2 RUN-ADMISSION): where the host meminfo is read; default /proc/meminfo. */
export const HOST_MEMINFO_PATH_ENV = "MYRMIDON_HOST_MEMINFO_PATH";
const DEFAULT_HOST_MEMINFO_PATH = "/proc/meminfo";
/** How long the host floor must hold runs back before the attention signal (10 min). */
export const HOST_MEMORY_HOLD_SIGNAL_MS = 10 * 60_000;
// Two holds further apart than this are two separate holds: the queue was
// served (or emptied) in between. The resweep retries every 15 s while held.
const HOST_MEMORY_HOLD_CONTINUITY_MS = 2 * 60_000;
/** myrmidon(1.6.5 RUN-ADMISSION): how long the CPU ceiling must hold runs back before the signal (10 min). */
export const HOST_CPU_HOLD_SIGNAL_MS = 10 * 60_000;
// Same continuity rule as the host memory hold: two CPU holds further apart
// than this are two separate holds.
const HOST_CPU_HOLD_CONTINUITY_MS = 2 * 60_000;
/** myrmidon(1.6.5 RUN-ADMISSION): where the host load average is read; default /proc/loadavg. */
export const HOST_LOADAVG_PATH_ENV = "MYRMIDON_HOST_LOADAVG_PATH";
const DEFAULT_HOST_LOADAVG_PATH = "/proc/loadavg";

const START_WINDOW_MS = 60_000;
// A run started this recently has not grown into the cgroup memory yet.
const MEMORY_SETTLE_MS = 30_000;
const MB = 1024 * 1024;

export type RunAdmissionLimits = RunLimits;

/** The limits as the environment declares them, with the built-in defaults. */
export function readRunAdmissionLimits(env: NodeJS.ProcessEnv = process.env): RunAdmissionLimits {
  return readRunLimitsFromEnv(env);
}

/** Why the memory guard cannot see a limit; `reason` goes to the log verbatim. */
export type CgroupMemoryLimit =
  | { known: true; freeBytes: number }
  | { known: false; reason: string };

/**
 * Free memory of this process's cgroup (v2) in bytes, or the reason it is
 * unknown (no limit, cgroup v1, not in a container). Inactive page cache is
 * reclaimable and does not count as used. Synchronous on purpose: three tiny
 * kernel files, and no await keeps `reserve` atomic.
 *
 * myrmidon(C0): the reason matters. With `MYRMIDON_MIN_FREE_MEMORY_MB` set and
 * no visible limit the memory guard silently does nothing, and an operator
 * cannot tell that from a guard that passes. The reason is logged once by
 * `createRunAdmission` (see below) instead of being dropped.
 */
export function readCgroupMemoryLimit(
  root = "/sys/fs/cgroup",
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): CgroupMemoryLimit {
  let maxRaw: string;
  try {
    maxRaw = readFile(`${root}/memory.max`).trim();
  } catch {
    return {
      known: false,
      reason: `${root}/memory.max is not readable: cgroup v1, or this process is not in a cgroup`,
    };
  }
  if (maxRaw === "max") {
    return {
      known: false,
      reason: `${root}/memory.max is 'max': the cgroup of this process has no memory limit, so MYRMIDON_MIN_FREE_MEMORY_MB cannot be enforced`,
    };
  }
  const max = Number(maxRaw);
  if (!Number.isFinite(max)) {
    return { known: false, reason: `${root}/memory.max is not a number: '${maxRaw}'` };
  }
  let current: number;
  let inactive: number;
  try {
    current = Number(readFile(`${root}/memory.current`).trim());
    inactive = Number(/^inactive_file (\d+)$/m.exec(readFile(`${root}/memory.stat`))?.[1] ?? 0);
  } catch {
    return {
      known: false,
      reason: `${root}/memory.current or memory.stat is not readable, so free memory cannot be counted`,
    };
  }
  if (!Number.isFinite(current)) {
    return { known: false, reason: `${root}/memory.current is not a number: '${current}'` };
  }
  return { known: true, freeBytes: max - Math.max(0, current - inactive) };
}

/**
 * Free memory of this process's cgroup (v2) in bytes, or null when unknown.
 * Thin wrapper over `readCgroupMemoryLimit` for callers that only need the
 * number; the reason is available there.
 */
export function readCgroupFreeMemoryBytes(
  root = "/sys/fs/cgroup",
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): number | null {
  const limit = readCgroupMemoryLimit(root, readFile);
  return limit.known ? limit.freeBytes : null;
}

/** myrmidon(1.6.2 RUN-ADMISSION): the host's memory, or why it cannot be read. */
export type HostMemoryReading =
  | { known: true; availableBytes: number; totalBytes: number }
  | { known: false; reason: string };

/**
 * Host MemAvailable from a meminfo file. Synchronous for the same reason as
 * the cgroup read: one small kernel file, and `reserve` must not await.
 *
 * A container's /proc/meminfo is the host's unless lxcfs virtualizes it; then
 * MemTotal equals the container's cgroup limit and the number would be the
 * container's, not the host's — that reading is refused with a reason.
 */
export function readHostMemory(
  options: {
    meminfoPath?: string;
    cgroupRoot?: string;
    readFile?: (path: string) => string;
  } = {},
): HostMemoryReading {
  const meminfoPath = options.meminfoPath ?? DEFAULT_HOST_MEMINFO_PATH;
  const cgroupRoot = options.cgroupRoot ?? "/sys/fs/cgroup";
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  let raw: string;
  try {
    raw = readFile(meminfoPath);
  } catch {
    return { known: false, reason: `${meminfoPath} is not readable` };
  }
  const kb = (field: string): number | null => {
    const match = new RegExp(`^${field}:\\s+(\\d+)\\s*kB$`, "m").exec(raw);
    return match ? Number(match[1]) * 1024 : null;
  };
  const totalBytes = kb("MemTotal");
  const availableBytes = kb("MemAvailable");
  if (totalBytes === null || availableBytes === null) {
    return { known: false, reason: `${meminfoPath} has no MemTotal/MemAvailable line (kernel older than 3.14?)` };
  }
  try {
    const max = Number(readFile(`${cgroupRoot}/memory.max`).trim());
    if (Number.isFinite(max) && Math.abs(max - totalBytes) <= 1024 * 1024) {
      return {
        known: false,
        reason: `${meminfoPath} reports the container's memory limit as MemTotal (lxcfs?), not the host's; mount the host's /proc/meminfo and set ${HOST_MEMINFO_PATH_ENV}`,
      };
    }
  } catch {
    // No cgroup limit file: nothing to compare against, the reading stands.
  }
  return { known: true, availableBytes, totalBytes };
}

/** myrmidon(1.6.5 RUN-ADMISSION): the host's CPU load, or why it cannot be read. */
export type HostCpuReading =
  | { known: true; load1: number; cores: number }
  | { known: false; reason: string };

/**
 * Host 1-minute load average from /proc/loadavg and the visible CPU count.
 * Synchronous for the same reason as the memory read, and the load average is
 * a host-wide kernel counter: Docker does not namespace /proc/loadavg, and
 * `os.cpus()` lists the host's CPUs in a container without lxcfs. The ratio
 * load1/cores is what the ceiling compares against (a load of 95 on 16 cores
 * is 594 % of a core, whatever the machine's absolute size). A failed or
 * empty `os.cpus()` — hidden CPUs, an unsupported platform — refuses the
 * reading as "unknown" rather than dividing by a guessed core count.
 */
export function readHostCpuLoad(
  options: {
    loadavgPath?: string;
    readFile?: (path: string) => string;
    cpuCount?: () => number;
  } = {},
): HostCpuReading {
  const loadavgPath = options.loadavgPath ?? DEFAULT_HOST_LOADAVG_PATH;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const coresOf = options.cpuCount ?? (() => cpus().length);
  let raw: string;
  try {
    raw = readFile(loadavgPath);
  } catch {
    return { known: false, reason: `${loadavgPath} is not readable` };
  }
  const load1 = Number.parseFloat(/^\s*(\d+(?:\.\d+)?)/.exec(raw)?.[1] ?? "");
  if (!Number.isFinite(load1)) {
    return { known: false, reason: `${loadavgPath} has no numeric 1-minute load field: '${raw.trim().slice(0, 80)}'` };
  }
  let cores: number;
  try {
    cores = coresOf();
  } catch {
    cores = 0;
  }
  if (!Number.isInteger(cores) || cores <= 0) {
    return { known: false, reason: "the number of visible CPU cores is unknown, so load per core cannot be counted" };
  }
  return { known: true, load1, cores };
}

/**
 * One continuous hold of a gate (myrmidon 1.6.5: shared by the host memory
 * floor and the host CPU ceiling). The hold starts at the first closed
 * reading and ends when the gate opens, when a fresh closed reading follows a
 * gap longer than `continuityMs` (the queue was served or emptied in between),
 * or when the cap is switched off. `observe` returns true when the state
 * changed, which is exactly when the hold event fires — one line per hold,
 * not one per resweep.
 */
function createGateHold(continuityMs: number) {
  let since: number | null = null;
  let lastHeldAt = 0;
  return {
    /** The continuous hold, or null; pass the time of a `closed` reading. */
    current(at: number): number | null {
      if (since === null) return null;
      return at - lastHeldAt <= continuityMs ? since : null;
    },
    /** Record a closed reading; returns true when the hold (re)started. */
    start(at: number): boolean {
      const continuing = this.current(at);
      since = continuing ?? at;
      lastHeldAt = at;
      return continuing === null;
    },
    /** Record an open/off reading; returns the hold length in ms, or null when nothing was held. */
    end(at: number): number | null {
      const held = this.current(at);
      since = null;
      return held === null ? null : at - held;
    },
    reset(): void {
      since = null;
      lastHeldAt = 0;
    },
  };
}

/** myrmidon(1.6.2 RUN-ADMISSION): the host memory floor as the admission sees it now. */
export interface HostMemoryGate {
  /** `off`: no floor set; `unknown`: host memory unreadable (floor inactive); `open`/`closed`. */
  state: "off" | "unknown" | "open" | "closed";
  thresholdMb: number | null;
  /** Host MemAvailable, MB, when known. */
  availableMb: number | null;
  /** Runs started in the last 30 s, budgeted on top of what the host shows. */
  settlingRuns: number;
  /** Why the floor is closed or unknown, for logs; null when open or off. */
  reason: string | null;
  /** Since when the floor has held runs back (continuous hold), or null. */
  heldSince: Date | null;
}

/** myrmidon(1.6.5 RUN-ADMISSION): the host CPU ceiling as the admission sees it now. */
export interface HostCpuGate {
  /** `off`: no ceiling set; `unknown`: load unreadable (ceiling inactive); `open`/`closed`. */
  state: "off" | "unknown" | "open" | "closed";
  /** The ceiling in percent of one core, or null when off. */
  thresholdPercent: number | null;
  /** Host 1-minute load average, when known. */
  load1: number | null;
  /** Visible CPU cores, when known. */
  cores: number | null;
  /** load1 per core in percent of one core, when known. */
  loadPercentPerCore: number | null;
  /** Why the ceiling is closed or unknown, for logs; null when open or off. */
  reason: string | null;
  /** Since when the ceiling has held runs back (continuous hold), or null. */
  heldSince: Date | null;
}

export interface RunAdmission {
  /**
   * How many of `wanted` runs may start now; the slots are taken at once.
   * Hand back the ones not started with `release(unused)`, and call
   * `finish()` once for every started run when it ends.
   */
  reserve(wanted: number): number;
  release(unused: number): void;
  finish(): void;
  /**
   * Raise the in-process count to the runs the database has in `running`: an
   * execution can settle while its row is still running (hand-off, deferred
   * finish), and the count must not drift below reality.
   */
  syncRunning(running: number): void;
  /** True when the last `reserve` gave fewer slots than wanted because of a limit. */
  limited(): boolean;
  /**
   * Replace the limits in force. Written into the object `reserve` reads, so
   * the next reservation sees the new ceiling without a restart (no run in
   * flight has to be dropped) and without re-creating the singleton, which
   * would lose the running count and the start window.
   */
  updateLimits(next: RunAdmissionLimits): void;
  /** The limits in force right now, as a copy. */
  limits(): RunAdmissionLimits;
  /**
   * myrmidon(1.6.2 RUN-ADMISSION): the host memory floor, evaluated now with
   * the same rule `reserve` applies. Reads the host meminfo; takes no slot.
   */
  hostMemoryGate(): HostMemoryGate;
  /**
   * myrmidon(1.6.5 RUN-ADMISSION): the host CPU ceiling, evaluated now with
   * the same rule `reserve` applies. Reads the host load average; takes no
   * slot. The swarm idle-wake pass asks this before it wakes anyone, so it
   * does not pile wakes onto a saturated host.
   */
  hostCpuGate(): HostCpuGate;
}

export function createRunAdmission(options: {
  limits: RunAdmissionLimits;
  freeMemoryBytes?: () => number | null;
  /** Called when the memory guard cannot read a limit, so it stays inactive. */
  onMemoryLimitUnavailable?: () => void;
  /** myrmidon(1.6.2): host memory source; defaults to /proc/meminfo. */
  hostMemory?: () => HostMemoryReading;
  /** myrmidon(1.6.2): host memory unreadable, so the host floor stays inactive. */
  onHostMemoryUnavailable?: (reason: string) => void;
  /** myrmidon(1.6.2): the host floor started (`closed`) or stopped (`open`) holding runs back. */
  onHostMemoryHold?: (event: { state: "closed" | "open"; gate: HostMemoryGate; heldMs: number }) => void;
  /** myrmidon(1.6.5): host load source; defaults to /proc/loadavg + os.cpus(). */
  hostCpuLoad?: () => HostCpuReading;
  /** myrmidon(1.6.5): the host CPU ceiling unreadable, so it stays inactive. */
  onHostCpuUnavailable?: (reason: string) => void;
  /** myrmidon(1.6.5): the CPU ceiling started (`closed`) or stopped (`open`) holding runs back. */
  onHostCpuHold?: (event: { state: "closed" | "open"; gate: HostCpuGate; heldMs: number }) => void;
  now?: () => number;
}): RunAdmission {
  const { limits } = options;
  const freeMemoryBytes = options.freeMemoryBytes ?? (() => readCgroupFreeMemoryBytes());
  const hostMemory = options.hostMemory ?? (() => readHostMemory());
  const hostCpuLoad = options.hostCpuLoad ?? (() => readHostCpuLoad());
  const now = options.now ?? Date.now;
  const starts: number[] = [];
  let active = 0;
  let lastLimited = false;
  // myrmidon(1.6.2): the current continuous hold by the host floor.
  // myrmidon(1.6.5): both holds run through the same gate-hold machine.
  const hostMemoryHold = createGateHold(HOST_MEMORY_HOLD_CONTINUITY_MS);
  // myrmidon(1.6.5): the current continuous hold by the host CPU ceiling.
  const cpuHold = createGateHold(HOST_CPU_HOLD_CONTINUITY_MS);

  function prune(at: number) {
    while (starts.length > 0 && at - starts[0]! >= START_WINDOW_MS) starts.shift();
  }

  function settlingAt(at: number): number {
    return starts.filter((startedAt) => at - startedAt < MEMORY_SETTLE_MS).length;
  }

  function evaluateHostGate(at: number): HostMemoryGate {
    const thresholdMb = limits.minFreeHostMemoryMb;
    const settlingRuns = settlingAt(at);
    const held = hostMemoryHold.current(at);
    const heldSince = held === null ? null : new Date(held);
    if (thresholdMb === null) {
      return { state: "off", thresholdMb, availableMb: null, settlingRuns, reason: null, heldSince: null };
    }
    const reading = hostMemory();
    if (!reading.known) {
      return { state: "unknown", thresholdMb, availableMb: null, settlingRuns, reason: reading.reason, heldSince };
    }
    const availableMb = Math.floor(reading.availableBytes / MB);
    const budgetedMb = availableMb - settlingRuns * limits.runMemoryEstimateMb;
    if (budgetedMb >= thresholdMb) {
      return { state: "open", thresholdMb, availableMb, settlingRuns, reason: null, heldSince };
    }
    return {
      state: "closed",
      thresholdMb,
      availableMb,
      settlingRuns,
      reason:
        settlingRuns > 0
          ? `host MemAvailable ${availableMb} MB minus ${settlingRuns} run(s) still starting (${limits.runMemoryEstimateMb} MB each) is below the ${thresholdMb} MB floor`
          : `host MemAvailable ${availableMb} MB is below the ${thresholdMb} MB floor`,
      heldSince,
    };
  }

  /** myrmidon(1.6.5 RUN-ADMISSION): the host CPU ceiling, evaluated like the memory floor. */
  function evaluateHostCpuGate(at: number): HostCpuGate {
    const thresholdPercent = limits.maxHostLoadPercentPerCore;
    const held = cpuHold.current(at);
    const heldSince = held === null ? null : new Date(held);
    if (thresholdPercent === null) {
      return {
        state: "off",
        thresholdPercent,
        load1: null,
        cores: null,
        loadPercentPerCore: null,
        reason: null,
        heldSince: null,
      };
    }
    const reading = hostCpuLoad();
    if (!reading.known) {
      return {
        state: "unknown",
        thresholdPercent,
        load1: null,
        cores: null,
        loadPercentPerCore: null,
        reason: reading.reason,
        heldSince,
      };
    }
    const loadPercentPerCore = Math.round((reading.load1 / reading.cores) * 100);
    if (loadPercentPerCore < thresholdPercent) {
      return {
        state: "open",
        thresholdPercent,
        load1: reading.load1,
        cores: reading.cores,
        loadPercentPerCore,
        reason: null,
        heldSince,
      };
    }
    return {
      state: "closed",
      thresholdPercent,
      load1: reading.load1,
      cores: reading.cores,
      loadPercentPerCore,
      reason: `host load average ${reading.load1.toFixed(2)} on ${reading.cores} core(s) is ${loadPercentPerCore} % of a core, at or above the ${thresholdPercent} % CPU ceiling`,
      heldSince,
    };
  }

  return {
    reserve(wanted) {
      if (wanted <= 0) return 0;
      const at = now();
      prune(at);
      let allowed = wanted;
      if (limits.maxConcurrentRuns !== null) {
        allowed = Math.min(allowed, limits.maxConcurrentRuns - active);
      }
      if (limits.maxStartsPerMinute !== null) {
        allowed = Math.min(allowed, limits.maxStartsPerMinute - starts.length);
      }
      if (limits.minFreeMemoryMb !== null && allowed > 0) {
        const free = freeMemoryBytes();
        // Unknown free memory (no cgroup limit) leaves the other limits in charge.
        if (free !== null) {
          const settling = settlingAt(at);
          const estimate = limits.runMemoryEstimateMb * MB;
          const spare = free - limits.minFreeMemoryMb * MB - settling * estimate;
          allowed = Math.min(allowed, Math.floor(spare / estimate));
        } else {
          // myrmidon(C0): the guard is inactive, and that must be visible.
          options.onMemoryLimitUnavailable?.();
        }
      }
      // myrmidon(1.6.2 RUN-ADMISSION): the host floor, after the cheap limits,
      // so a reservation the other limits already refuse reads no file.
      if (limits.minFreeHostMemoryMb !== null && allowed > 0) {
        const gate = evaluateHostGate(at);
        if (gate.state === "closed") {
          allowed = 0;
          if (hostMemoryHold.start(at)) {
            options.onHostMemoryHold?.({ state: "closed", gate: { ...gate, heldSince: new Date(at) }, heldMs: 0 });
          }
        } else {
          if (gate.state === "unknown") options.onHostMemoryUnavailable?.(gate.reason ?? "unknown");
          const heldMs = hostMemoryHold.end(at);
          if (heldMs !== null) {
            options.onHostMemoryHold?.({ state: "open", gate, heldMs });
          }
        }
      }
      // myrmidon(1.6.5 RUN-ADMISSION): the host CPU ceiling, after the memory
      // floor: both are host readings, the memory one fails first on the
      // 05.10 pattern and the log should name the floor that held. A run
      // refused by the ceiling stays `queued` like one refused by the floor.
      if (limits.maxHostLoadPercentPerCore !== null && allowed > 0) {
        const gate = evaluateHostCpuGate(at);
        if (gate.state === "closed") {
          allowed = 0;
          if (cpuHold.start(at)) {
            options.onHostCpuHold?.({ state: "closed", gate: { ...gate, heldSince: new Date(at) }, heldMs: 0 });
          }
        } else {
          if (gate.state === "unknown") options.onHostCpuUnavailable?.(gate.reason ?? "unknown");
          const heldMs = cpuHold.end(at);
          if (heldMs !== null) {
            options.onHostCpuHold?.({ state: "open", gate, heldMs });
          }
        }
      }
      allowed = Math.max(0, allowed);
      lastLimited = allowed < wanted;
      active += allowed;
      for (let i = 0; i < allowed; i += 1) starts.push(at);
      return allowed;
    },
    release(unused) {
      if (unused <= 0) return;
      active = Math.max(0, active - unused);
      starts.splice(starts.length - Math.min(unused, starts.length), unused);
    },
    finish() {
      active = Math.max(0, active - 1);
    },
    syncRunning(running) {
      // Only raise: lowering could drop slots reserved for claims still in flight.
      if (Number.isInteger(running) && running > active) active = running;
    },
    limited() {
      return lastLimited;
    },
    updateLimits(next) {
      limits.maxConcurrentRuns = next.maxConcurrentRuns;
      limits.maxStartsPerMinute = next.maxStartsPerMinute;
      limits.minFreeMemoryMb = next.minFreeMemoryMb;
      limits.runMemoryEstimateMb = next.runMemoryEstimateMb;
      limits.minFreeHostMemoryMb = next.minFreeHostMemoryMb;
      limits.maxHostLoadPercentPerCore = next.maxHostLoadPercentPerCore;
      // A floor switched off (or changed) ends the hold it caused; the next
      // reservation measures again against the new floor. Same for the CPU
      // ceiling (myrmidon 1.6.5).
      if (next.minFreeHostMemoryMb === null) hostMemoryHold.reset();
      if (next.maxHostLoadPercentPerCore === null) cpuHold.reset();
    },
    limits() {
      return { ...limits };
    },
    hostMemoryGate() {
      const at = now();
      prune(at);
      return evaluateHostGate(at);
    },
    hostCpuGate() {
      const at = now();
      prune(at);
      return evaluateHostCpuGate(at);
    },
  };
}

const RESWEEP_DELAY_MS = 15_000;
let resweepTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Run `sweep` once after a short delay, when admission held runs back. One
 * pending timer per process: repeated calls before it fires do nothing.
 */
export function scheduleQueuedResweep(sweep: () => unknown, delayMs = RESWEEP_DELAY_MS): void {
  if (resweepTimer) return;
  resweepTimer = setTimeout(() => {
    resweepTimer = null;
    void sweep();
  }, delayMs);
  resweepTimer.unref?.();
}

let shared: RunAdmission | null = null;

// myrmidon(C0): the memory guard is inactive when the cgroup limit is not
// visible to the process (memory.max is 'max', cgroup v1, or not in a
// container). That is a normal configuration, not a failure, so it is logged
// once per process instead of being dropped: with MYRMIDON_MIN_FREE_MEMORY_MB
// set and no visible limit, the cap rests on the concurrency and start-rate
// limits alone, and nothing else tells an operator about it.
let memoryLimitWarningLogged = false;

function warnMemoryLimitUnavailableOnce(): void {
  if (memoryLimitWarningLogged) return;
  memoryLimitWarningLogged = true;
  const limit = readCgroupMemoryLimit();
  logger.warn(
    {
      env: MIN_FREE_MEMORY_MB_ENV,
      reason: limit.known
        ? "the cgroup limit disappeared between two reads of the same file"
        : limit.reason,
    },
    "run admission cannot read the cgroup memory limit: the free-memory guard is inactive, only the concurrency and start-rate limits apply",
  );
}

// myrmidon(1.6.2 RUN-ADMISSION): an unreadable host meminfo leaves the host
// floor inactive; like the cgroup case, that is said once, not dropped.
let hostMemoryWarningLogged = false;

function warnHostMemoryUnavailableOnce(reason: string): void {
  if (hostMemoryWarningLogged) return;
  hostMemoryWarningLogged = true;
  logger.warn(
    { env: MIN_FREE_HOST_MEMORY_MB_ENV, reason },
    "run admission cannot read host memory: the host free-memory floor is inactive, the other run limits still apply",
  );
}

// myrmidon(1.6.5 RUN-ADMISSION): an unreadable host load leaves the CPU
// ceiling inactive; like the memory case, that is said once, not dropped.
let hostCpuWarningLogged = false;

function warnHostCpuUnavailableOnce(reason: string): void {
  if (hostCpuWarningLogged) return;
  hostCpuWarningLogged = true;
  logger.warn(
    { env: MAX_HOST_LOAD_PERCENT_PER_CORE_ENV, reason },
    "run admission cannot read the host CPU load: the host load ceiling is inactive, the other run limits still apply",
  );
}

function logHostCpuHold(event: { state: "closed" | "open"; gate: HostCpuGate; heldMs: number }): void {
  const fields = {
    load1: event.gate.load1,
    cores: event.gate.cores,
    loadPercentPerCore: event.gate.loadPercentPerCore,
    thresholdPercent: event.gate.thresholdPercent,
  };
  if (event.state === "closed") {
    logger.warn(
      { ...fields, reason: event.gate.reason },
      "run admission holds new runs: the host CPU load is at or above the ceiling; runs stay queued and are retried",
    );
  } else {
    logger.info(
      { ...fields, heldMs: event.heldMs },
      "run admission resumes starting runs: the host CPU load is back below the ceiling",
    );
  }
}

function logHostMemoryHold(event: { state: "closed" | "open"; gate: HostMemoryGate; heldMs: number }): void {
  const fields = {
    availableMb: event.gate.availableMb,
    thresholdMb: event.gate.thresholdMb,
    settlingRuns: event.gate.settlingRuns,
  };
  if (event.state === "closed") {
    logger.warn(
      { ...fields, reason: event.gate.reason },
      "run admission holds new runs: host free memory is below the floor; runs stay queued and are retried",
    );
  } else {
    logger.info(
      { ...fields, heldMs: event.heldMs },
      "run admission resumes starting runs: host free memory is back above the floor",
    );
  }
}

/**
 * One admission per server process: heartbeatService is instantiated by many
 * routes and services, and the counters must be shared by all of them.
 */
export function sharedRunAdmission(): RunAdmission {
  if (!shared) {
    const meminfoPath = process.env[HOST_MEMINFO_PATH_ENV]?.trim() || undefined;
    // myrmidon(1.6.5 RUN-ADMISSION): the host load average path, like meminfo.
    const loadavgPath = process.env[HOST_LOADAVG_PATH_ENV]?.trim() || undefined;
    shared = createRunAdmission({
      limits: readRunAdmissionLimits(),
      onMemoryLimitUnavailable: warnMemoryLimitUnavailableOnce,
      hostMemory: () => readHostMemory({ meminfoPath }),
      onHostMemoryUnavailable: warnHostMemoryUnavailableOnce,
      onHostMemoryHold: logHostMemoryHold,
      hostCpuLoad: () => readHostCpuLoad({ loadavgPath }),
      onHostCpuUnavailable: warnHostCpuUnavailableOnce,
      onHostCpuHold: logHostCpuHold,
    });
  }
  return shared;
}

/** Test hook: drop the process-wide admission so the next call rereads the env. */
export function resetSharedRunAdmissionForTests(): void {
  shared = null;
  memoryLimitWarningLogged = false;
  hostMemoryWarningLogged = false;
  hostCpuWarningLogged = false;
}

/**
 * Put limits in force on the process-wide admission (myrmidon C0,
 * RUNTIME-LIMITS). The server calls this at startup, after reading
 * `instance_settings.general.runLimits`, and again on every settings write, so
 * a changed ceiling reaches the queue without a restart. Called before any
 * route has touched the admission, it creates the singleton with these values
 * instead of the environment ones.
 */
export function applyRunAdmissionLimits(limits: RunAdmissionLimits): void {
  sharedRunAdmission().updateLimits(limits);
}

/** The limits the process-wide admission enforces right now. */
export function currentRunAdmissionLimits(): RunAdmissionLimits {
  return sharedRunAdmission().limits();
}

/**
 * myrmidon(1.6.2 RUN-ADMISSION): the host memory floor of the process-wide
 * admission, evaluated now. The swarm idle-wake pass asks this before it
 * wakes anyone, so it does not pile wakes on a host that cannot start them.
 */
export function currentHostMemoryGate(): HostMemoryGate {
  return sharedRunAdmission().hostMemoryGate();
}

/**
 * myrmidon(1.6.5 RUN-ADMISSION): the host CPU ceiling of the process-wide
 * admission, evaluated now. The swarm idle-wake pass asks this before it
 * wakes anyone, so it does not pile wakes onto a saturated host.
 */
export function currentHostCpuGate(): HostCpuGate {
  return sharedRunAdmission().hostCpuGate();
}

/** The attention signal: runs held back by the host floor for over 10 minutes. */
export interface HostMemoryHoldSignal {
  heldSince: Date;
  heldMs: number;
  availableMb: number | null;
  thresholdMb: number | null;
  reason: string | null;
}

/**
 * myrmidon(1.6.2 RUN-ADMISSION): the signal while the host floor has held new
 * runs back continuously for longer than `HOST_MEMORY_HOLD_SIGNAL_MS`, or null.
 * The hold is "continuous" while the 15 s resweep keeps meeting a closed floor;
 * it ends the first time the floor admits a run or the queue stops asking.
 */
export function hostMemoryHoldSignal(
  gate: HostMemoryGate = currentHostMemoryGate(),
  now: number = Date.now(),
  thresholdMs: number = HOST_MEMORY_HOLD_SIGNAL_MS,
): HostMemoryHoldSignal | null {
  if (gate.state !== "closed" || !gate.heldSince) return null;
  const heldMs = now - gate.heldSince.getTime();
  if (heldMs < thresholdMs) return null;
  return {
    heldSince: gate.heldSince,
    heldMs,
    availableMb: gate.availableMb,
    thresholdMb: gate.thresholdMb,
    reason: gate.reason,
  };
}

/** The attention signal: runs held back by the host CPU ceiling for over 10 minutes. */
export interface HostCpuHoldSignal {
  heldSince: Date;
  heldMs: number;
  load1: number | null;
  cores: number | null;
  loadPercentPerCore: number | null;
  thresholdPercent: number | null;
  reason: string | null;
}

/**
 * myrmidon(1.6.5 RUN-ADMISSION): the signal while the host CPU ceiling has
 * held new runs back continuously for longer than `HOST_CPU_HOLD_SIGNAL_MS`,
 * or null. The same continuity rule as the host memory hold: the 15 s resweep
 * keeps meeting the closed ceiling; the hold ends the first time the ceiling
 * admits a run or the queue stops asking.
 */
export function hostCpuHoldSignal(
  gate: HostCpuGate = currentHostCpuGate(),
  now: number = Date.now(),
  thresholdMs: number = HOST_CPU_HOLD_SIGNAL_MS,
): HostCpuHoldSignal | null {
  if (gate.state !== "closed" || !gate.heldSince) return null;
  const heldMs = now - gate.heldSince.getTime();
  if (heldMs < thresholdMs) return null;
  return {
    heldSince: gate.heldSince,
    heldMs,
    load1: gate.load1,
    cores: gate.cores,
    loadPercentPerCore: gate.loadPercentPerCore,
    thresholdPercent: gate.thresholdPercent,
    reason: gate.reason,
  };
}
