// myrmidon(MONITOR-IDLE-LOOP, OPE-13141): a due monitor on a task that waits for
// its subtasks must not wake a model when nothing the task depends on changed.
//
// Observed on 1.6.9-rc.5: a lead owned an epic with two subtasks whose pull
// requests were not merged yet, its monitor fired every ~20 minutes, each run
// found "still not merged", re-armed the monitor and went to sleep. 8 runs and
// 15 million input tokens in 7 hours, with no change of the epic.
//
// The board compares a snapshot of the task and its subtasks with the one it
// recorded at the previous wake. Nothing new: the wake is not enqueued and the
// monitor moves on. After `limit` unchanged terms in a row the monitor is
// removed and the removal is written to the activity log. The owner of a
// parent is woken by the board for the events that matter (a subtask is done,
// a subtask's pull request is merged), so waiting needs no polling by a model.
//
// Pure decisions here; the snapshot and the observation are read by `store.ts`.

export const MONITOR_UNCHANGED_WAKE_LIMIT_KEY = "monitorUnchangedWakeLimit";
export const DEFAULT_MONITOR_UNCHANGED_WAKE_LIMIT = 3;
/** The shortest silent re-arm of an unchanged monitor; it doubles with each unchanged term. */
export const MONITOR_UNCHANGED_MIN_INTERVAL_MS = 10 * 60_000;
export const MONITOR_UNCHANGED_MAX_INTERVAL_MS = 60 * 60_000;

export const MONITOR_OBSERVATION_ACTIONS = ["issue.monitor_triggered", "issue.monitor_deferred"] as const;
export const MONITOR_UNCHANGED_DEFER_REASON = "issue_state_unchanged";
export const MONITOR_UNCHANGED_CLEAR_REASON = "unchanged_wake_limit";

function readProcessesRecord(general: unknown): Record<string, unknown> | null {
  if (!general || typeof general !== "object" || Array.isArray(general)) return null;
  const processes = (general as Record<string, unknown>).processes;
  if (!processes || typeof processes !== "object" || Array.isArray(processes)) return null;
  return processes as Record<string, unknown>;
}

/** `general.processes.monitorUnchangedWakeLimit`: default 3, 0 turns the protection off. */
export function resolveMonitorUnchangedWakeLimit(general: unknown): number {
  const behaviorSettings = general && typeof general === "object" && !Array.isArray(general)
    ? (general as Record<string, unknown>).behaviorSettings
    : null;
  const saved = behaviorSettings && typeof behaviorSettings === "object" && !Array.isArray(behaviorSettings)
    ? (behaviorSettings as Record<string, unknown>)[MONITOR_UNCHANGED_WAKE_LIMIT_KEY]
    : undefined;
  const raw = saved ?? readProcessesRecord(general)?.[MONITOR_UNCHANGED_WAKE_LIMIT_KEY];
  const numeric =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : Number.NaN;
  if (!Number.isFinite(numeric)) return DEFAULT_MONITOR_UNCHANGED_WAKE_LIMIT;
  const rounded = Math.round(numeric);
  if (rounded <= 0) return 0;
  return Math.min(100, rounded);
}

export interface MonitorObservation {
  snapshotHash: string;
  /** Unchanged terms in a row at the time it was recorded; 0 for a wake. */
  unchangedCount: number;
}

export type IdleMonitorDecision =
  | { action: "wake" }
  | { action: "defer"; unchangedCount: number; nextCheckAt: Date }
  | { action: "clear"; unchangedCount: number };

export function decideIdleMonitor(input: {
  now: Date;
  snapshotHash: string;
  previous: MonitorObservation | null;
  limit: number;
}): IdleMonitorDecision {
  if (input.limit <= 0 || !input.previous || input.previous.snapshotHash !== input.snapshotHash) {
    return { action: "wake" };
  }
  const unchangedCount = input.previous.unchangedCount + 1;
  if (unchangedCount >= input.limit) return { action: "clear", unchangedCount };
  const delayMs = Math.min(
    MONITOR_UNCHANGED_MAX_INTERVAL_MS,
    MONITOR_UNCHANGED_MIN_INTERVAL_MS * 2 ** Math.max(0, unchangedCount - 1),
  );
  return { action: "defer", unchangedCount, nextCheckAt: new Date(input.now.getTime() + delayMs) };
}
