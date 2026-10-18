// server/src/myrmidon/process-readiness/service.ts
//
// myrmidon(1.6.6 PROCS-1.5, design BOARD-PROCESSES §4.4): the runtime half of
// the readiness module — it resolves the three checks of THIS process into a
// snapshot.
//
// Every check is cheap and side-effect free:
//   * `database`   — one `SELECT 1` through the existing pool, with a deadline
//                    so a wedged connection cannot hold the balancer's request
//                    open until its own timeout;
//   * `migrations` — the in-memory boot phase of startup recovery, which
//                    index.ts moves to `ready` only after migrations ran;
//   * `bus`        — the subscription flag the bus wiring reports. Nothing
//                    subscribes today, so the check is `not_applicable` until
//                    a process actually reports a subscription: the split must
//                    not report a healthy board as unready on a check that its
//                    deployment never uses.

import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { getStartupRecoveryState } from "../../startup-recovery-state.js";
import {
  boardProcessBootId,
  resolveBoardProcessRole,
  type BoardProcessRole,
} from "../process-registry/domain.js";
import {
  processReady,
  type ProcessReadinessSnapshot,
  type ProcessSupervisorReadinessSource,
  type ReadinessCheck,
} from "./domain.js";

/** Deadline of the database probe. One round-trip on a local socket is
 * microseconds; a second is already an incident, and answering 503 fast is
 * better than answering 200 late. */
export const READINESS_PROBE_TIMEOUT_MS = 1_000;

const NO_DATABASE_DETAIL = "no database in this process";
const NO_BUS_DETAIL = "no bus subscription reported by this process";
const BUS_STOPPED_DETAIL = "bus subscription stopped";

/** What the bus wiring knows about its subscription. `null` means «this
 * process has no bus duty», which does not block readiness. */
export type ProcessBusReadinessState = {
  active: boolean;
  channels: readonly string[];
  detail?: string | null;
};

export type ProcessReadinessOptions = {
  db?: Db | null;
  /** Role override; `PAPERCLIP_PROCESS_ROLE` otherwise. */
  role?: BoardProcessRole;
  bootId?: string;
  /** Test seam: replaces the `SELECT 1` probe. */
  databaseProbe?: () => Promise<boolean>;
  /** Test seam: replaces the boot-phase reader. */
  migrationsApplied?: () => boolean;
  probeTimeoutMs?: number;
};

export type ProcessReadiness = {
  role(): BoardProcessRole;
  bootId(): string;
  /** Runs the checks of this heartbeat. No caching: a 503 must clear as soon
   * as the cause does. */
  checks(): Promise<ReadinessCheck[]>;
  snapshot(): Promise<ProcessReadinessSnapshot>;
  /** The bus wiring reports its subscription here. Never throws. */
  reportBusSubscription(state: ProcessBusReadinessState | null): void;
};

/** A promise that rejects when the deadline passes, so a hung probe cannot
 * hold a readiness request open. */
async function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`readiness probe timed out after ${timeoutMs} ms`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errorDetail(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "readiness probe failed";
}

export function createProcessReadiness(
  options: ProcessReadinessOptions = {},
): ProcessReadiness {
  const role = options.role ?? resolveBoardProcessRole();
  const bootId = options.bootId ?? boardProcessBootId;
  const probeTimeoutMs = options.probeTimeoutMs ?? READINESS_PROBE_TIMEOUT_MS;
  const db = options.db ?? null;
  let bus: ProcessBusReadinessState | null = null;

  const databaseCheck = async (): Promise<ReadinessCheck> => {
    const probe =
      options.databaseProbe ??
      (db
        ? async () => {
            await db.execute(sql`SELECT 1`);
            return true;
          }
        : null);
    if (!probe) {
      return { id: "database", status: "not_applicable", detail: NO_DATABASE_DETAIL };
    }
    try {
      const ok = await withDeadline(probe(), probeTimeoutMs);
      return ok
        ? { id: "database", status: "ok", detail: null }
        : { id: "database", status: "not_ready", detail: "database probe reported not ready" };
    } catch (error) {
      return { id: "database", status: "not_ready", detail: errorDetail(error) };
    }
  };

  const migrationsCheck = (): ReadinessCheck => {
    const applied = options.migrationsApplied
      ? options.migrationsApplied()
      : getStartupRecoveryState().phase === "ready";
    return applied
      ? { id: "migrations", status: "ok", detail: null }
      : { id: "migrations", status: "not_ready", detail: "boot recovery is not finished" };
  };

  const busCheck = (): ReadinessCheck => {
    if (!bus) return { id: "bus", status: "not_applicable", detail: NO_BUS_DETAIL };
    if (!bus.active) {
      return { id: "bus", status: "not_ready", detail: bus.detail ?? BUS_STOPPED_DETAIL };
    }
    return {
      id: "bus",
      status: "ok",
      detail: bus.channels.length ? `channels: ${bus.channels.join(", ")}` : null,
    };
  };

  const checks = async (): Promise<ReadinessCheck[]> => [
    await databaseCheck(),
    migrationsCheck(),
    busCheck(),
  ];

  return {
    role: () => role,
    bootId: () => bootId,
    checks,
    snapshot: async () => {
      const resolved = await checks();
      return {
        ready: processReady(resolved),
        role,
        bootId,
        checks: resolved,
        at: new Date().toISOString(),
      };
    },
    reportBusSubscription: (state) => {
      bus = state ? { ...state, channels: [...state.channels] } : null;
    },
  };
}

/** The `start`/`stop` surface of the inter-process bus (PROCS-1.3) this module
 * needs. Declared structurally so readiness does not import the bus. */
export type ProcessBusLike = {
  start(): Promise<void>;
  stop(): Promise<void>;
};

/** Wraps a bus so the readiness flag follows the real subscription: the flag
 * turns on only after `start()` resolved (the LISTEN is then live), and off as
 * soon as `stop()` is called. Returning a wrapper — instead of a callback the
 * caller must remember — keeps the two facts in one place, so a wiring that
 * forgets the callback cannot report a silent `not_applicable` where a real
 * subscription is required. */
export function bindProcessBusReadiness(
  readiness: ProcessReadiness,
  bus: ProcessBusLike,
  channels: readonly string[] = [],
): ProcessBusLike {
  return {
    async start() {
      await bus.start();
      readiness.reportBusSubscription({ active: true, channels: [...channels] });
    },
    async stop() {
      readiness.reportBusSubscription({
        active: false,
        channels: [...channels],
        detail: BUS_STOPPED_DETAIL,
      });
      await bus.stop();
    },
  };
}

/** The process-local supervisor of THIS container, registered by the wiring
 * that owns it (PROCS-1.2 forks and tracks the api children in
 * `server/src/index.ts`). The app reads it as a fallback for `opts`, so the
 * aggregate starts covering all N children as soon as the split wiring
 * registers — the wiring does not have to touch `app.ts` a second time.
 * `null` means «this process has no supervisor»: an api child, or a container
 * that never enters a split. */
let registeredSupervisor: ProcessSupervisorReadinessSource | null = null;

/** Registers (or clears, with `null`) the supervisor this process tracks. */
export function registerProcessSupervisor(
  supervisor: ProcessSupervisorReadinessSource | null,
): void {
  registeredSupervisor = supervisor;
}

/** The supervisor to aggregate over: the registered one, or `null` when this
 * process tracks no children and must answer for itself. */
export function processSupervisorForHealthz(): ProcessSupervisorReadinessSource | null {
  return registeredSupervisor;
}