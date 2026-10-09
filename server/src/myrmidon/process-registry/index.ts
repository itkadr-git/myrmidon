// server/src/myrmidon/process-registry/index.ts
//
// myrmidon(1.6.6 PROCS-0.1): wiring of the process registry — the routes the
// «Процессы» panel reads and the pulse the board starts at boot.

import type { Db } from "@paperclipai/db";
import { serverVersion } from "../../version.js";
import {
  boardProcessBootId,
  resolveBoardProcessIdentity,
  resolveBoardProcessRole,
  type BoardProcessIdentity,
  type BoardProcessRole,
} from "./domain.js";
import {
  createBoardProcessPulse,
  type BoardProcessPulse,
  type BoardProcessPulseFailurePhase,
} from "./pulse.js";
import { myrmidonBoardProcessRegistryRoutes } from "./routes.js";
import { createBoardProcessStore, type BoardProcessStore } from "./store.js";

export { myrmidonBoardProcessRegistryRoutes } from "./routes.js";
export {
  BOARD_PROCESS_PULSE_MS,
  BOARD_PROCESS_STALE_MS,
  boardProcessAgeSeconds,
  boardProcessBootId,
  boardProcessStatus,
  isBoardProcessStale,
  resolveBoardProcessIdentity,
  resolveBoardProcessRole,
  roleOwnsBackgroundWork,
} from "./domain.js";
export { createBoardProcessPulse } from "./pulse.js";
export { createBoardProcessStore } from "./store.js";
export type { BoardProcessIdentity, BoardProcessRole } from "./domain.js";
export type { BoardProcessPulse } from "./pulse.js";
export type { BoardProcessRow, BoardProcessStore } from "./store.js";

export type StartBoardProcessRegistryOptions = {
  /** Version reported in the registry row; the board's own by default. */
  version?: string;
  /** Role override (tests); `PAPERCLIP_PROCESS_ROLE` otherwise. */
  role?: BoardProcessRole;
  bootId?: string;
  /** Port this process serves, when it serves one. */
  apiPort?: number | null;
  pulseMs?: number;
  staleMs?: number;
  store?: BoardProcessStore;
  onError?: (error: unknown, phase: BoardProcessPulseFailurePhase) => void;
};

let activeRegistry: BoardProcessPulse | null = null;

/** Starts the pulse of THIS process: writes its row once, then every 10 s, and
 * reaps stale rows when the role owns background work. Idempotent — a second
 * call replaces the previous pulse, so a repeated boot never leaves two
 * timers on the same row. */
export function startBoardProcessRegistry(
  db: Db,
  options: StartBoardProcessRegistryOptions = {},
): BoardProcessPulse {
  stopBoardProcessRegistry();
  const store = options.store ?? createBoardProcessStore(db);
  const identity: BoardProcessIdentity = resolveBoardProcessIdentity({
    version: options.version ?? serverVersion,
    role: options.role,
    bootId: options.bootId,
    apiPort: options.apiPort ?? null,
  });
  const pulse = createBoardProcessPulse({
    store,
    identity,
    pulseMs: options.pulseMs,
    staleMs: options.staleMs,
    onError: options.onError,
  });
  pulse.start();
  activeRegistry = pulse;
  return pulse;
}

/** Stops the pulse of this process (shutdown and tests). */
export function stopBoardProcessRegistry(): void {
  activeRegistry?.stop();
  activeRegistry = null;
}

/** Identity of this process as the registry uses it (tests and diagnostics). */
export function boardProcessRegistryIdentity(
  options: StartBoardProcessRegistryOptions = {},
): BoardProcessIdentity {
  return resolveBoardProcessIdentity({
    version: options.version ?? serverVersion,
    role: options.role ?? resolveBoardProcessRole(),
    bootId: options.bootId ?? boardProcessBootId,
    apiPort: options.apiPort ?? null,
  });
}
