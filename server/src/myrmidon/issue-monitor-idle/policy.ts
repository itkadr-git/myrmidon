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

// myrmidon(EMPTY-RUNS-MONITOR, 1.6.9): waits that cannot change anything must not cost a model run.

/** Longest silent pause between two wakes of a monitor whose observed state did not change. */
export const MONITOR_UNCHANGED_BACKOFF_MAX_MS = 4 * 60 * 60_000;

export type UnchangedBackoffDecision =
  | { action: "wake" }
  | { action: "defer"; unchangedCount: number; nextCheckAt: Date };

/**
 * A monitor of a task without subtasks: the same fingerprint as at the previous term means the
 * wake would find nothing new. The pause doubles with every unchanged term (10 min, 20 min, ...)
 * and stops growing at four hours. A changed fingerprint, or no earlier record, wakes at once.
 */
export function decideUnchangedBackoff(input: {
  now: Date;
  snapshotHash: string;
  previous: MonitorObservation | null;
}): UnchangedBackoffDecision {
  if (!input.previous || input.previous.snapshotHash !== input.snapshotHash) return { action: "wake" };
  const unchangedCount = input.previous.unchangedCount + 1;
  const delayMs = Math.min(
    MONITOR_UNCHANGED_BACKOFF_MAX_MS,
    MONITOR_UNCHANGED_MIN_INTERVAL_MS * 2 ** Math.min(20, Math.max(0, unchangedCount - 1)),
  );
  return { action: "defer", unchangedCount, nextCheckAt: new Date(input.now.getTime() + delayMs) };
}

/** Consecutive unreadable-CI terms (no access to the repository) after which the monitor is removed. */
export const CI_NO_ACCESS_MAX_FAILURES = 3;
export const CI_NO_ACCESS_DEFER_REASON = "review_ci_no_access";
export const CI_NO_ACCESS_NOTE = "CI не читается: нет доступа к репозиторию. Монитор снят.";

/** A CI read that GitHub refused for this repository (401/403/404, not a rate limit). */
export function isCiAccessDeniedReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  // Every read attempt (with the token, then anonymous) must have been refused: a token that was
  // refused while the anonymous read was only rate limited says nothing about access.
  return reason.split("+").every((part) => /http_(401|403|404)(?!_rate_limited)/.test(part));
}

/** A repository counts as unreadable only when the refusals span at least this long (first to last). */
export const CI_NO_ACCESS_MIN_WINDOW_MS = 15 * 60_000;
/** Pause between two reads of a CI the board has no access to. */
export const CI_NO_ACCESS_PAUSE_MS = 5 * 60_000;

/**
 * Waits whose state the board reads itself: the pull-request state and CI marks of the board's
 * own "CI" monitor. Only these may back off on an unchanged fingerprint; a monitor of an external
 * service (a deploy, a vendor) changes where the board cannot see, so it wakes on its date.
 */
export const BOARD_VISIBLE_CI_MONITOR_SERVICE_NAME = "CI";

/** The monitor stops after its limit of attempts: one note, no wake of the owner. */
export function maxAttemptsExhaustedNote(input: {
  attemptCount: number;
  maxAttempts: number | null;
  /** The due time of the monitor that ran out: tells one monitor of the task from the next. */
  scheduledAt: string;
}): string {
  return `Монитор снят: исчерпан предел попыток (${input.attemptCount} из ${input.maxAttempts ?? "?"}, срок ${input.scheduledAt}). Исполнитель не будится; новый монитор ставится только осознанно.`;
}

/** Pause of a reviewer wake the per-tick quota could not admit. */
export const REVIEW_WAKE_QUOTA_DEFER_MS = 60_000;
export const REVIEW_WAKE_QUOTA_DEFER_REASON = "review_wake_quota";
