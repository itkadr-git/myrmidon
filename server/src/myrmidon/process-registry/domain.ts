// server/src/myrmidon/process-registry/domain.ts
//
// myrmidon(1.6.6 PROCS-0.1, design BOARD-PROCESSES §5.1): who this board
// process is and how the registry decides that a row is stale. Pure functions
// and constants only — no DB, no timers — so the pulse, the store and the
// panel API share one definition of identity and staleness.

import { randomUUID } from "node:crypto";
import os from "node:os";

/** Roles of the split layout (design §2.1): `all` is today's single process
 * (`mode=single`), `worker` runs the backend work, `api` only serves HTTP. */
export const BOARD_PROCESS_ROLES = ["all", "worker", "api"] as const;
export type BoardProcessRole = (typeof BOARD_PROCESS_ROLES)[number];

/** Pulse cadence of the registry: every process refreshes its row (design §5.1). */
export const BOARD_PROCESS_PULSE_MS = 10_000;

/** Rows older than this are stale: the leader reaps them, and the panel shows
 * the process as gone (design §5.1 — "2 минуты"). Comfortably larger than a
 * few pulses so one lost tick, a GC pause or a slow query cannot retire a
 * live process. */
export const BOARD_PROCESS_STALE_MS = 120_000;

/** Identity of THIS process: a random UUID per process, exactly like
 * `legacyControllerBootId` (design §3). A PID or a hostname does not survive a
 * container restart, and a reused PID would overwrite the row of a process
 * that is still running. */
export const boardProcessBootId = randomUUID();

/** `PAPERCLIP_PROCESS_ROLE` when the split layout sets it, `all` otherwise —
 * the T0.1 default is byte-for-byte today's behaviour (one process, one row). */
export function resolveBoardProcessRole(
  raw: string | undefined = process.env.PAPERCLIP_PROCESS_ROLE,
): BoardProcessRole {
  const value = (raw ?? "").trim().toLowerCase();
  return (BOARD_PROCESS_ROLES as readonly string[]).includes(value)
    ? (value as BoardProcessRole)
    : "all";
}

/** Whether a role owns the background timers (design §2.1): an `api` child
 * owns none, so it neither reaps stale rows nor claims leader work. */
export function roleOwnsBackgroundWork(role: BoardProcessRole): boolean {
  return role !== "api";
}

/** Container id when the process runs in one. Docker sets `HOSTNAME` to the
 * container id (the same field `tool-runtime-supervisor` uses as its hostId);
 * `MYRMIDON_PROCESS_CONTAINER` overrides it for split deployments where the
 * container name is the operator's, not the runtime's. */
export function resolveBoardProcessContainer(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const explicit = (env.MYRMIDON_PROCESS_CONTAINER ?? "").trim();
  if (explicit) return explicit;
  const hostname = (env.HOSTNAME ?? "").trim();
  return hostname ? hostname : null;
}

export type BoardProcessIdentity = {
  /** Random per-process UUID — the primary key of the row. */
  bootId: string;
  role: BoardProcessRole;
  pid: number;
  hostname: string;
  container: string | null;
  version: string;
  startedAt: Date;
  /** HTTP port this process serves, when it serves one. */
  apiPort: number | null;
};

/** Stable identity of this process, resolved once at startup. */
export function resolveBoardProcessIdentity(options: {
  version: string;
  role?: BoardProcessRole;
  bootId?: string;
  pid?: number;
  hostname?: string;
  container?: string | null;
  startedAt?: Date;
  apiPort?: number | null;
}): BoardProcessIdentity {
  return {
    bootId: options.bootId ?? boardProcessBootId,
    role: options.role ?? resolveBoardProcessRole(),
    pid: options.pid ?? process.pid,
    hostname: options.hostname ?? os.hostname(),
    container: options.container === undefined ? resolveBoardProcessContainer() : options.container,
    version: options.version,
    startedAt: options.startedAt ?? new Date(),
    apiPort: options.apiPort ?? null,
  };
}

/** A row is stale when its last pulse is older than the window — the leader
 * deletes exactly these rows, and the panel marks them accordingly. */
export function isBoardProcessStale(
  lastSeenAt: Date,
  now: Date,
  staleMs: number = BOARD_PROCESS_STALE_MS,
): boolean {
  return now.getTime() - lastSeenAt.getTime() > staleMs;
}

/** Age of the last pulse in whole seconds, floored at 0 (clock skew must not
 * show a negative age). */
export function boardProcessAgeSeconds(lastSeenAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - lastSeenAt.getTime()) / 1000));
}

export type BoardProcessStatus = "live" | "stale";

export function boardProcessStatus(
  lastSeenAt: Date,
  now: Date,
  staleMs: number = BOARD_PROCESS_STALE_MS,
): BoardProcessStatus {
  return isBoardProcessStale(lastSeenAt, now, staleMs) ? "stale" : "live";
}
