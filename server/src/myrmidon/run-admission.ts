import { readFileSync } from "node:fs";
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
 * No locks: the server is one Node.js thread, and `reserve` checks and counts
 * without awaiting anything, so two agents cannot both take the last slot.
 */

export const MAX_CONCURRENT_RUNS_ENV = RUN_LIMITS_ENV_KEYS.maxConcurrentRuns;
export const MAX_RUN_STARTS_PER_MINUTE_ENV = RUN_LIMITS_ENV_KEYS.maxStartsPerMinute;
export const MIN_FREE_MEMORY_MB_ENV = RUN_LIMITS_ENV_KEYS.minFreeMemoryMb;
export const RUN_MEMORY_ESTIMATE_MB_ENV = RUN_LIMITS_ENV_KEYS.runMemoryEstimateMb;
export const MIN_FREE_HOST_MEMORY_MB_ENV = RUN_LIMITS_ENV_KEYS.minFreeHostMemoryMb;
/** myrmidon(1.6.2 RUN-ADMISSION): where the host meminfo is read; default /proc/meminfo. */
export const HOST_MEMINFO_PATH_ENV = "MYRMIDON_HOST_MEMINFO_PATH";
const DEFAULT_HOST_MEMINFO_PATH = "/proc/meminfo";
/** How long the host floor must hold runs back before the attention signal (10 min). */
export const HOST_MEMORY_HOLD_SIGNAL_MS = 10 * 60_000;
// Two holds further apart than this are two separate holds: the queue was
// served (or emptied) in between. The resweep retries every 15 s while held.
const HOST_MEMORY_HOLD_CONTINUITY_MS = 2 * 60_000;

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
  now?: () => number;
}): RunAdmission {
  const { limits } = options;
  const freeMemoryBytes = options.freeMemoryBytes ?? (() => readCgroupFreeMemoryBytes());
  const hostMemory = options.hostMemory ?? (() => readHostMemory());
  const now = options.now ?? Date.now;
  const starts: number[] = [];
  let active = 0;
  let lastLimited = false;
  // myrmidon(1.6.2): the current continuous hold by the host floor.
  let hostHeldSince: number | null = null;
  let hostLastHeldAt = 0;

  function prune(at: number) {
    while (starts.length > 0 && at - starts[0]! >= START_WINDOW_MS) starts.shift();
  }

  function settlingAt(at: number): number {
    return starts.filter((startedAt) => at - startedAt < MEMORY_SETTLE_MS).length;
  }

  function currentHold(at: number): number | null {
    if (hostHeldSince === null) return null;
    return at - hostLastHeldAt <= HOST_MEMORY_HOLD_CONTINUITY_MS ? hostHeldSince : null;
  }

  function evaluateHostGate(at: number): HostMemoryGate {
    const thresholdMb = limits.minFreeHostMemoryMb;
    const settlingRuns = settlingAt(at);
    const held = currentHold(at);
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
          const continuing = currentHold(at);
          hostHeldSince = continuing ?? at;
          hostLastHeldAt = at;
          if (continuing === null) {
            options.onHostMemoryHold?.({ state: "closed", gate: { ...gate, heldSince: new Date(at) }, heldMs: 0 });
          }
        } else {
          if (gate.state === "unknown") options.onHostMemoryUnavailable?.(gate.reason ?? "unknown");
          const held = currentHold(at);
          if (held !== null) {
            options.onHostMemoryHold?.({ state: "open", gate, heldMs: at - held });
          }
          hostHeldSince = null;
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
      // A floor switched off (or changed) ends the hold it caused; the next
      // reservation measures again against the new floor.
      if (next.minFreeHostMemoryMb === null) hostHeldSince = null;
    },
    limits() {
      return { ...limits };
    },
    hostMemoryGate() {
      const at = now();
      prune(at);
      return evaluateHostGate(at);
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
    shared = createRunAdmission({
      limits: readRunAdmissionLimits(),
      onMemoryLimitUnavailable: warnMemoryLimitUnavailableOnce,
      hostMemory: () => readHostMemory({ meminfoPath }),
      onHostMemoryUnavailable: warnHostMemoryUnavailableOnce,
      onHostMemoryHold: logHostMemoryHold,
    });
  }
  return shared;
}

/** Test hook: drop the process-wide admission so the next call rereads the env. */
export function resetSharedRunAdmissionForTests(): void {
  shared = null;
  memoryLimitWarningLogged = false;
  hostMemoryWarningLogged = false;
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
