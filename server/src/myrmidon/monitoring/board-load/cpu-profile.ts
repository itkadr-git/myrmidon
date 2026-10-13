// server/src/myrmidon/monitoring/board-load/cpu-profile.ts
//
// myrmidon(1.6.6 PROCS-0.3A): the CPU profile of design OPE-5394 §1 П1.
//
// #700 was diagnosed by hand: an operator ran `node --cpu-prof` against the
// board, which means a restart (the flag is a startup flag) and a copy of the
// profile off the host. The workaround was as expensive as the incident. This
// module takes the profile from the running process instead — the V8 inspector
// profiler is started and stopped from inside the board, so the CPU sample is
// taken while the load being investigated is actually on the process, and the
// profile leaves as a file (a `.cpuprofile`, the format Chrome DevTools and
// `node --cpu-prof-process` read).
//
// Default behaviour is unchanged: nothing is profiled until an operator asks
// for it, one at a time (the V8 profiler is a process-wide singleton — a second
// concurrent start would either corrupt the first sample or fail), and the
// timer is the operator's: a capture stops itself after the requested seconds.
//
// What the profile can and cannot say: it is a CPU sample of the *whole*
// process, so it points at a hot function, not at a lane. Reading it next to
// `myrmidon_board_lane_busy_seconds_total` (lanes.ts) is what turns "this
// function is hot" into "this lane is hot".

import { Session } from "node:inspector";

/** Seconds a capture profiles for unless the caller asks for less. */
export const CPU_PROFILE_DEFAULT_SECONDS = 60;
/** Shortest capture worth taking — below this V8 has too few samples to read. */
export const CPU_PROFILE_MIN_SECONDS = 5;
/** Longest capture allowed: the profiler buffers samples in process memory. */
export const CPU_PROFILE_MAX_SECONDS = 60;
/** A retained profile larger than this is reported but not kept in memory. */
export const DEFAULT_CPU_PROFILE_MAX_RETAINED_BYTES = 32 * 1024 * 1024;

/** Thrown when a capture is asked for while another one is running. */
export class CpuProfileBusyError extends Error {
  constructor() {
    super("a CPU profile capture is already running");
    this.name = "CpuProfileBusyError";
  }
}

/** The subset of a V8 inspector session a capture uses. */
export interface CpuProfileSessionPort {
  enable(): Promise<void>;
  start(): Promise<void>;
  /** The raw `Profiler.stop` result (`{ profile }` for the V8 profiler). */
  stop(): Promise<unknown>;
  disable(): Promise<void>;
}

export interface CpuProfileCapture {
  seconds: number;
  startedAt: string;
  finishedAt: string;
  /** The `.cpuprofile` document as it is served. */
  json: string;
  bytes: number;
}

export interface CpuProfileRuntimeStatus {
  inFlight: boolean;
  defaultSeconds: number;
  minSeconds: number;
  maxSeconds: number;
  latest: {
    seconds: number;
    startedAt: string;
    finishedAt: string;
    bytes: number;
    retained: boolean;
  } | null;
}

export interface CpuProfileRuntime {
  capture(input?: { seconds?: unknown }): Promise<CpuProfileCapture>;
  status(): CpuProfileRuntimeStatus;
  /**
   * Body of the last retained capture, or `null` when nothing was captured yet
   * (or the last one was too large to keep). Lets an operator collect the
   * profile of a capture whose response they never received.
   */
  latestJson(): string | null;
}

/**
 * Coerces a request value into the allowed capture length.
 *
 * Anything absent, unparsable, negative or absurd collapses to the nearest
 * allowed value instead of failing: an operator asking for a profile gets one
 * within the documented bounds rather than a validation puzzle.
 */
export function clampCpuProfileSeconds(raw: unknown): number {
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim().length > 0
        ? Number(raw)
        : Number.NaN;
  if (!Number.isFinite(value)) return CPU_PROFILE_DEFAULT_SECONDS;
  const whole = Math.floor(value);
  if (whole < CPU_PROFILE_MIN_SECONDS) return CPU_PROFILE_MIN_SECONDS;
  if (whole > CPU_PROFILE_MAX_SECONDS) return CPU_PROFILE_MAX_SECONDS;
  return whole;
}

function post(session: Session, method: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    session.post(method, (error: Error | null, result?: unknown) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

/** A real V8 inspector session of this process. Connected on creation. */
export function inspectorCpuProfileSession(): CpuProfileSessionPort {
  const session = new Session();
  session.connect();
  return {
    async enable() {
      await post(session, "Profiler.enable");
    },
    async start() {
      await post(session, "Profiler.start");
    },
    async stop() {
      return post(session, "Profiler.stop");
    },
    async disable() {
      await post(session, "Profiler.disable");
    },
  };
}

/** Unwraps `Profiler.stop`'s `{ profile }` envelope. */
function profileBodyFrom(stopped: unknown): unknown {
  if (stopped !== null && typeof stopped === "object" && "profile" in stopped) {
    const profile = (stopped as { profile?: unknown }).profile;
    if (profile !== undefined && profile !== null) return profile;
  }
  return stopped;
}

/**
 * Profiles the process for `seconds` and returns the document.
 *
 * The session is disabled in a `finally`, whatever happens in between: leaving
 * the V8 profiler enabled would keep sampling the process long after the
 * operator stopped asking for it — the exact permanent overhead this ticket
 * exists to avoid.
 */
export async function captureCpuProfile(input: {
  seconds: number;
  session?: CpuProfileSessionPort;
  sleep?: (ms: number) => Promise<void>;
}): Promise<CpuProfileCapture> {
  const session = input.session ?? inspectorCpuProfileSession();
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = new Date();
  await session.enable();
  try {
    await session.start();
    await sleep(Math.max(0, input.seconds) * 1000);
    const stopped = await session.stop();
    const json = JSON.stringify(profileBodyFrom(stopped));
    return {
      seconds: input.seconds,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      json,
      bytes: Buffer.byteLength(json),
    };
  } finally {
    try {
      await session.disable();
    } catch {
      // A session that refuses to disable must not replace the capture's own
      // outcome: the profile is already in hand, and the process is going to
      // be restarted or the profiler re-enabled by the next capture anyway.
    }
  }
}

/**
 * The process's one profiler: single-flight captures plus the last result.
 *
 * Holding the last capture is what makes the endpoint usable from a browser:
 * a 60 s profile of a busy board can outlive the operator's HTTP client, and
 * `latestJson()` lets them fetch the profile afterwards instead of taking
 * another one.
 */
export function createCpuProfileRuntime(
  options: {
    session?: CpuProfileSessionPort;
    sleep?: (ms: number) => Promise<void>;
    maxRetainedBytes?: number;
  } = {},
): CpuProfileRuntime {
  const maxRetainedBytes = Math.max(0, options.maxRetainedBytes ?? DEFAULT_CPU_PROFILE_MAX_RETAINED_BYTES);
  let inFlight = false;
  let latestRetained: CpuProfileCapture | null = null;
  let latestMeta: CpuProfileRuntimeStatus["latest"] = null;

  return {
    async capture(input = {}) {
      if (inFlight) throw new CpuProfileBusyError();
      inFlight = true;
      try {
        const capture = await captureCpuProfile({
          seconds: clampCpuProfileSeconds(input.seconds),
          session: options.session,
          sleep: options.sleep,
        });
        // A capture too large to keep is still returned to the caller; only the
        // in-memory copy is dropped, so an operator's other 59 s profile cannot
        // push the process into the memory problem they are profiling for.
        const retained = capture.bytes <= maxRetainedBytes;
        latestRetained = retained ? capture : null;
        latestMeta = {
          seconds: capture.seconds,
          startedAt: capture.startedAt,
          finishedAt: capture.finishedAt,
          bytes: capture.bytes,
          retained,
        };
        return capture;
      } finally {
        inFlight = false;
      }
    },
    status() {
      return {
        inFlight,
        defaultSeconds: CPU_PROFILE_DEFAULT_SECONDS,
        minSeconds: CPU_PROFILE_MIN_SECONDS,
        maxSeconds: CPU_PROFILE_MAX_SECONDS,
        latest: latestMeta,
      };
    },
    latestJson() {
      return latestRetained ? latestRetained.json : null;
    },
  };
}