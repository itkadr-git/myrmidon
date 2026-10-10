// Board processes (myrmidon 1.6.5 BOARD-PROCESSES): GET
// /api/myrmidon/board-processes.
//
// The read side of the process registry: every running board process with its
// role, its pulse and its last measurements. Read-only — the rows are written
// by the processes themselves, the panel only shows them.
import { api } from "@/api/client";

/** One row of `board_processes` as the panel shows it. */
export interface BoardProcessView {
  bootId: string;
  /** `all` in today's mode, `worker`/`api` once the split lands (T1.1). */
  role: string;
  pid: number;
  hostname: string;
  container: string | null;
  version: string;
  startedAt: string;
  lastSeenAt: string;
  /** Seconds since `startedAt` (uptime), computed by the server at read time. */
  uptimeSeconds: number;
  /** Seconds since `lastSeenAt`, computed by the server at read time. */
  ageSeconds: number;
  apiPort: number | null;
  eventLoopLagMs: number | null;
  rssBytes: number | null;
  /** Older than the staleness window: the leader will reap this row. */
  status: "live" | "stale";
  /** This very process (its own row). */
  self: boolean;
}

export interface BoardProcessesView {
  selfBootId: string;
  pulseSeconds: number;
  staleAfterSeconds: number;
  processes: BoardProcessView[];
}

export const boardProcessesQueryKey = ["myrmidon", "board-processes"] as const;

/** The panel refreshes at the pulse cadence, so a process that stops
 * answering shows up as stale within one tick. */
export const BOARD_PROCESSES_POLL_MS = 10_000;

export const boardProcessesApi = {
  list: () => api.get<BoardProcessesView>("/myrmidon/board-processes"),
};
