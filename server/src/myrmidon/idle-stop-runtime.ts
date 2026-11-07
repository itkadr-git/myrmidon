import type { BotContainerStatus } from "./bot-containers/driver.js";

export interface IdleStopRuntime {
  /** The container was stopped by IDLE-STOP (not by an operator) and is waiting for the next run. */
  idleStopped: boolean;
  lastStoppedAt: Date | null;
  lastStartedAt: Date | null;
}

function dockerTime(value: unknown): Date | null {
  // Docker reports "0001-01-01T00:00:00Z" for a time that never happened.
  if (typeof value !== "string" || value === "" || value.startsWith("0001-")) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * Last stop/start times of a bot container, read from the container's own docker inspect
 * (State.FinishedAt / State.StartedAt) — they survive a board restart, unlike in-memory marks.
 * A running container's FinishedAt is its previous stop.
 */
export function idleStopRuntimeFromStatus(status: BotContainerStatus): IdleStopRuntime {
  const state = (status.inspect as { State?: { StartedAt?: unknown; FinishedAt?: unknown } } | undefined)?.State;
  return {
    idleStopped: status.idleStopped === true,
    lastStoppedAt: dockerTime(state?.FinishedAt),
    lastStartedAt: dockerTime(state?.StartedAt),
  };
}
