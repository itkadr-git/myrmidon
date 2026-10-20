// server/src/myrmidon/processes/supervisor.ts
//
// myrmidon(PROCS-1.2, design OPE-5394 §7.1): the child-process supervisor of
// the board. The worker (tini's first child) forks N api processes out of the
// same entrypoint with `PAPERCLIP_PROCESS_ROLE=api`, watches their IPC
// readiness, restarts them with a backoff, and opens/closes its own :3100
// listener as the operator flips `general.processes.mode` between `single`
// and `split`.
//
// One instance per process; the worker owns it. An api child never constructs
// one — its role profile has no supervisor duties, and the settings service
// on an api node only stores the row (the worker applies it on its own read).
//
// States the worker's own listener moves through:
//
//   single          — worker listens on 0.0.0.0:3100 itself, no children.
//   startingSplit   — children forking; worker still on :3100 until every
//                     child reports `ready` over IPC.
//   split           — children ready; worker's :3100 closed, children serve
//                     0.0.0.0:3100 with reusePort; worker keeps 127.0.0.1:3101.
//   drainingToSingle— worker re-opened :3100 (reusePort, so the children keep
//                     serving meanwhile) and is draining children one by one.
//   emergencySingle — no child stayed alive for the grace window; worker
//                     opened :3100 itself and raised the attention signal.
//
// The public surface is deliberately small: `createProcessSupervisor` builds
// it, `apply(settings)` moves it, `shutdown()` tears it down. Everything
// time-based takes injected timers so the tests run without real waits.

import { fork, type ChildProcess } from "node:child_process";
import type { Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { logger } from "../../middleware/logger.js";
import {
  PROCESS_ROLE_ENV,
  PROCESS_ROLE_API_HOST,
  PROCESS_ROLE_API_PORT,
} from "../../services/process-role.js";
import type { ProcessesSettings } from "@paperclipai/shared";

/** Env var the child reads to correlate its boot with the worker's. */
export const PARENT_BOOT_ID_ENV = "PAPERCLIP_PARENT_BOOT_ID";

/** IPC messages the api child sends to the worker. */
export const SUPERVISOR_IPC_READY = "myrmidon:supervisor:ready";
/** IPC messages the worker sends to an api child. */
export const SUPERVISOR_IPC_DRAIN = "myrmidon:supervisor:drain";

/** Backoff ladder for restarts: 1s doubling up to 30s (design §7.1). */
export const SUPERVISOR_BACKOFF_INITIAL_MS = 1_000;
export const SUPERVISOR_BACKOFF_MAX_MS = 30_000;
/** How long with zero live children before the worker re-opens :3100 itself. */
export const SUPERVISOR_NO_CHILD_GRACE_MS = 15_000;
/** Grace before `closeAllConnections()` on a drain (design §7.2). */
export const SUPERVISOR_DRAIN_GRACE_MS = 30_000;

/** Memory ceilings per role (design §7.1; the real numbers land with П7). */
export const SUPERVISOR_API_MAX_OLD_SPACE_MB = 1_024;

/** The board port the api children share (design §7.1). */
export interface SupervisorListenerHandle {
  close(): Promise<void>;
  closeIdleConnections(): void;
  closeAllConnections(): void;
  listening: boolean;
}

export interface SupervisorForkResult {
  child: ChildProcess;
}

/** Injectable seams: every side effect the supervisor causes goes through these. */
export interface ProcessSupervisorDeps {
  /** Forks one api child of the same entrypoint. */
  forkChild(env: NodeJS.ProcessEnv, execArgv: string[]): ChildProcess;
  /** Opens the worker's own listener on the public bind (single mode). */
  openPublicListener(): Promise<SupervisorListenerHandle>;
  /** Closes the worker's public listener without killing in-flight requests. */
  drainPublicListener(handle: SupervisorListenerHandle, graceMs: number): Promise<void>;
  /** Writes the attention signal when the emergency fallback fires. */
  writeAttentionSignal(details: Record<string, unknown>): void;
  /** SELECT 1 probe the child runs before it may report `ready`. */
  childReadinessProbe(): Promise<void>;
  now(): number;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  log: {
    debug(fields: object, message: string): void;
    info(fields: object, message: string): void;
    warn(fields: object, message: string): void;
    error(fields: object, message: string): void;
  };
}

export type SupervisorState =
  | "single"
  | "startingSplit"
  | "split"
  | "drainingToSingle"
  | "emergencySingle";

export interface SupervisorChildRecord {
  child: ChildProcess;
  pid: number | undefined;
  ready: boolean;
  draining: boolean;
  /** Backoff step for the next restart of this slot. */
  restartAttempts: number;
}

export interface ProcessSupervisor {
  /** Apply a new settings value; no-op when nothing relevant changed. */
  apply(settings: ProcessesSettings): Promise<void>;
  /** Current lifecycle state, for the settings view and for tests. */
  state(): SupervisorState;
  /** Live children registry snapshot. */
  children(): readonly SupervisorChildRecord[];
  /** Stop every child and close the worker's own listener; idempotent. */
  shutdown(): Promise<void>;
}

interface ChildSlot {
  record: SupervisorChildRecord;
  /** Slot id survives restarts — the registry is keyed by slot, not pid. */
  slotId: number;
}

function defaultLog() {
  return {
    debug: (f: object, m: string) => logger.debug(f, m),
    info: (f: object, m: string) => logger.info(f, m),
    warn: (f: object, m: string) => logger.warn(f, m),
    error: (f: object, m: string) => logger.error(f, m),
  };
}

/**
 * The production fork: same entrypoint, same execArgv (tsx loader included),
 * role pinned through env so the dockergate argv check sees no difference
 * (design §6 — the worker stays tini's first child with the unchanged argv).
 */
export function defaultForkChild(env: NodeJS.ProcessEnv, execArgv: string[]): ChildProcess {
  return fork(process.argv[1], [], {
    env: {
      ...process.env,
      ...env,
      [PROCESS_ROLE_ENV]: "api",
    },
    execArgv: [
      ...execArgv,
      `--max-old-space-size=${SUPERVISOR_API_MAX_OLD_SPACE_MB}`,
    ],
    // The IPC channel is the whole point; `silent: false` keeps stdio shared
    // so the child's pino lines land in the same container log stream.
    silent: false,
  });
}

export function createProcessSupervisor(deps: Partial<ProcessSupervisorDeps> = {}): ProcessSupervisor {
  const d: ProcessSupervisorDeps = {
    forkChild: deps.forkChild ?? defaultForkChild,
    openPublicListener: deps.openPublicListener ?? (async () => {
      throw new Error("process supervisor has no public listener wired (PROCS-1.2: worker integration gap)");
    }),
    drainPublicListener: deps.drainPublicListener ?? (async () => undefined),
    writeAttentionSignal: deps.writeAttentionSignal ?? (() => undefined),
    childReadinessProbe: deps.childReadinessProbe ?? (async () => undefined),
    now: deps.now ?? (() => Date.now()),
    setTimeout: deps.setTimeout ?? setTimeout,
    clearTimeout: deps.clearTimeout ?? clearTimeout,
    log: deps.log ?? defaultLog(),
  };

  const bootId = randomUUID();
  let state: SupervisorState = "single";
  let publicListener: SupervisorListenerHandle | null = null;
  let nextSlotId = 1;
  const slots = new Map<number, ChildSlot>();
  const pendingRestarts = new Map<number, ReturnType<typeof setTimeout>>();
  let noChildGraceTimer: ReturnType<typeof setTimeout> | null = null;
  let shuttingDown = false;
  /** The settings value the supervisor is converging on. */
  let desired: ProcessesSettings | null = null;

  function liveChildren(): ChildSlot[] {
    return [...slots.values()].filter((slot) => !slot.record.draining && slot.record.child.exitCode === null && slot.record.child.signalCode === null);
  }

  function readyChildren(): ChildSlot[] {
    return liveChildren().filter((slot) => slot.record.ready);
  }

  function clearNoChildGrace() {
    if (noChildGraceTimer !== null) {
      d.clearTimeout(noChildGraceTimer);
      noChildGraceTimer = null;
      d.log.debug({}, "myrmidon(PROCS-1.2): no-child grace cleared");
    }
  }

  async function openOwnListener(): Promise<void> {
    if (publicListener?.listening) return;
    publicListener = await d.openPublicListener();
    d.log.warn(
      { port: PROCESS_ROLE_API_PORT, host: PROCESS_ROLE_API_HOST },
      "myrmidon(PROCS-1.2): worker opened its own public listener (single lane)",
    );
  }

  async function closeOwnListener(graceMs: number): Promise<void> {
    if (!publicListener) return;
    const handle = publicListener;
    publicListener = null;
    await d.drainPublicListener(handle, graceMs);
    d.log.info(
      { graceMs },
      "myrmidon(PROCS-1.2): worker closed its public listener after the children reported ready",
    );
  }

  function scheduleNoChildGrace() {
    // Start the grace from the first moment with no live child — repeated
    // crashes must NOT slide the window forward, otherwise a crash loop with
    // backoff gaps shorter than the grace would postpone the fallback forever.
    if (noChildGraceTimer !== null) return;
    noChildGraceTimer = d.setTimeout(() => {
      noChildGraceTimer = null;
      if (state !== "split" && state !== "startingSplit") return;
      if (liveChildren().length > 0) return;
      void (async () => {
        state = "emergencySingle";
        d.writeAttentionSignal({
          reason: "no_live_api_children",
          graceMs: SUPERVISOR_NO_CHILD_GRACE_MS,
          desiredApiCount: desired?.apiCount ?? null,
        });
        d.log.error(
          { graceMs: SUPERVISOR_NO_CHILD_GRACE_MS },
          "myrmidon(PROCS-1.2): no live api child for the grace window — worker falling back to single",
        );
        await openOwnListener().catch((err) => {
          d.log.error({ err }, "myrmidon(PROCS-1.2): emergency public listener open failed");
        });
      })();
    }, SUPERVISOR_NO_CHILD_GRACE_MS);
  }

  function forkSlot(slotId: number, attempt: number, fromRestart = false): void {
    if (shuttingDown) return;
    // A crashed child's restart timer fired, but the desired split may have
    // shrunk since — do not over-fork past the desired count. Initial forks
    // (fromRestart=false) always go through: moveToSplit sized them itself.
    if (fromRestart) {
      const desiredCount = desired?.mode === "split" ? desired.apiCount : 0;
      if (liveChildren().length >= desiredCount) {
        d.log.debug(
          { slotId, attempt, live: liveChildren().length, desired: desiredCount },
          "myrmidon(PROCS-1.2): restart suppressed — already at desired api count",
        );
        return;
      }
    }
    const env: NodeJS.ProcessEnv = {
      [PARENT_BOOT_ID_ENV]: bootId,
    };
    const child = d.forkChild(env, process.execArgv);
    const record: SupervisorChildRecord = {
      child,
      pid: child.pid,
      ready: false,
      draining: false,
      restartAttempts: attempt,
    };
    slots.set(slotId, { record, slotId });
    d.log.info(
      { slotId, pid: child.pid, attempt },
      "myrmidon(PROCS-1.2): forked api child",
    );

    child.on("message", (message: unknown) => {
      if (typeof message !== "object" || message === null) return;
      const kind = (message as { type?: unknown }).type;
      if (kind === SUPERVISOR_IPC_READY) {
        record.ready = true;
        d.log.info({ slotId, pid: child.pid }, "myrmidon(PROCS-1.2): api child ready");
        void onChildReady();
      }
    });

    child.on("exit", (code, signal) => {
      slots.delete(slotId);
      if (shuttingDown) return;
      if (record.draining) {
        d.log.info({ slotId, pid: record.pid, code, signal }, "myrmidon(PROCS-1.2): drained api child exited");
        return;
      }
      const delayMs = Math.min(
        SUPERVISOR_BACKOFF_MAX_MS,
        SUPERVISOR_BACKOFF_INITIAL_MS * 2 ** Math.min(record.restartAttempts, 5),
      );
      d.log.warn(
        { slotId, pid: record.pid, code, signal, delayMs, attempt: record.restartAttempts + 1 },
        "myrmidon(PROCS-1.2): api child exited unexpectedly — restart with backoff",
      );
      if (state === "split" || state === "startingSplit") {
        const timer = d.setTimeout(() => {
          pendingRestarts.delete(slotId);
          forkSlot(slotId, record.restartAttempts + 1, true);
        }, delayMs);
        pendingRestarts.set(slotId, timer);
        if (liveChildren().length === 0) {
          scheduleNoChildGrace();
        }
      }
    });
  }

  async function onChildReady(): Promise<void> {
    if (state !== "startingSplit") return;
    const desiredCount = desired?.apiCount ?? 0;
    if (readyChildren().length < desiredCount) return;
    state = "split";
    clearNoChildGrace(); // the children are ready — the hang grace is moot
    await closeOwnListener(SUPERVISOR_DRAIN_GRACE_MS);
    d.log.info(
      { apiCount: desiredCount },
      "myrmidon(PROCS-1.2): split in force — children serve the public port",
    );
  }

  async function moveToSplit(settings: ProcessesSettings): Promise<void> {
    const want = settings.apiCount;
    const have = liveChildren().length;
    if (state === "single" || state === "emergencySingle") {
      state = "startingSplit";
      for (let i = 0; i < want; i += 1) {
        forkSlot(nextSlotId++, 0);
      }
      // A child that never reports ready AND never exits is the silent-hang
      // case: arm the no-child grace now. A child that reported ready cancels
      // the timer inside onChildReady's state transition... but the grace
      // belongs to "no live child": with live children the timer only watches
      // for the *ready* event, so cancel it as soon as every child is ready.
      scheduleNoChildGrace();
      return;
    }
    if (state === "split") {
      if (want > have) {
        for (let i = 0; i < want - have; i += 1) {
          forkSlot(nextSlotId++, 0);
        }
      } else if (want < have) {
        const victims = liveChildren().slice(0, have - want);
        for (const victim of victims) {
          drainChild(victim);
        }
      }
    }
  }

  function drainChild(slot: ChildSlot): void {
    if (slot.record.draining) return;
    slot.record.draining = true;
    d.log.info({ slotId: slot.slotId, pid: slot.record.pid }, "myrmidon(PROCS-1.2): draining api child");
    slot.record.child.send({ type: SUPERVISOR_IPC_DRAIN, graceMs: SUPERVISOR_DRAIN_GRACE_MS });
    // If the child ignores the drain, kill it after twice the grace. This
    // timer lives in `pendingRestarts` only so `shutdown()` clears it too.
    const killTimer = d.setTimeout(() => {
      pendingRestarts.delete(slot.slotId);
      if (slot.record.child.exitCode === null) {
        d.log.warn({ slotId: slot.slotId, pid: slot.record.pid }, "myrmidon(PROCS-1.2): drain grace expired — killing api child");
        slot.record.child.kill("SIGTERM");
      }
    }, SUPERVISOR_DRAIN_GRACE_MS * 2);
    pendingRestarts.set(slot.slotId, killTimer);
  }

  async function moveToSingle(): Promise<void> {
    // Already single with the listener up — nothing to do. The worker's own
    // startup listener is registered with the supervisor at wiring time, so
    // `publicListener` non-null is the single-mode steady state.
    if (state === "single" && publicListener !== null) return;
    state = "drainingToSingle";
    clearNoChildGrace();
    // reusePort lets the worker open :3100 while the children still serve it.
    await openOwnListener();
    for (const slot of liveChildren()) {
      drainChild(slot);
    }
    state = "single";
    d.log.info({}, "myrmidon(PROCS-1.2): back to single — worker serves the public port alone");
  }

  return {
    apply: async (next: ProcessesSettings) => {
      if (shuttingDown) return;
      const previous = desired;
      desired = next;
      if (next.mode === "split") {
        if (previous?.mode === "split" && previous.apiCount === next.apiCount) return;
        await moveToSplit(next);
        return;
      }
      await moveToSingle();
    },

    state: () => state,

    children: () => [...slots.values()].map((slot) => slot.record),

    async shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      clearNoChildGrace();
      for (const timer of pendingRestarts.values()) {
        d.clearTimeout(timer);
      }
      pendingRestarts.clear();
      // Mark every slot draining BEFORE the kills — a synchronous exit
      // listener otherwise re-arms restarts for the children we just killed.
      const live = liveChildren();
      for (const slot of live) {
        slot.record.draining = true;
      }
      for (const slot of live) {
        slot.record.child.kill("SIGTERM");
      }
      if (publicListener) {
        await d.drainPublicListener(publicListener, 0);
        publicListener = null;
      }
    },
  };
}
