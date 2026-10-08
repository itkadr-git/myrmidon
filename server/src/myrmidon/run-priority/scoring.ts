// myrmidon(1.6.5 RUN-PRIORITY A): queue scoring shared by both sweeps.
//
// `resumeQueuedRuns` (global pass) and `startNextQueuedRunForAgent` (per-agent
// pass) order their claimed runs by the effective weight from
// `runPriorityWeight` (packages/shared) with a tie-break on `createdAt`, so at
// a closed admission review, release and current-release runs start first.
// The admission limits themselves are untouched: this decides the order of
// the choice *within* the admitted number of slots only.

import {
  releaseTagMatches,
  runPriorityWeight,
  type RunPrioritySettings,
} from "@paperclipai/shared";

/** One queued run with everything the comparator needs. */
export interface PriorityScoredRun {
  /** Unique id, kept for stable ordering of equal scores. */
  id: string;
  createdAtMs: number;
  /** Inputs to the weight; null fields mean "no information" -> default weight. */
  role: string | null;
  hasIssue: boolean;
  issuePriority: string | null;
  /**
   * True when the run carries the current release: its issue label matched
   * the release tag, or the wake branch (contextSnapshot.branchName /
   * executionWorkspace branch) contains it.
   */
  releaseMatched: boolean;
}

/**
 * Compare two queued runs by priority: higher effective weight first, then
 * the optional `tieBreak` (the caller's issue-priority order: the weight is
 * max(role, issue priority), so within one agent, whose role is the same for
 * every run, high/medium/low issues of a strong role all weigh the same and
 * only this step keeps a high issue ahead of a low one), then
 * the older createdAt (the pre-feature FIFO order), then id for determinism.
 * When the feature is switched off every weight is 0 and this degenerates to
 * the createdAt FIFO.
 */
export function compareRunsByPriority(
  left: PriorityScoredRun,
  right: PriorityScoredRun,
  settings: RunPrioritySettings,
  nowMs: number = Date.now(),
  tieBreak?: (left: PriorityScoredRun, right: PriorityScoredRun) => number,
): number {
  const leftWeight = runPriorityWeight(
    {
      role: left.role,
      hasIssue: left.hasIssue,
      issuePriority: left.issuePriority,
      releaseMatched: left.releaseMatched,
      createdAtMs: left.createdAtMs,
    },
    settings,
    nowMs,
  );
  const rightWeight = runPriorityWeight(
    {
      role: right.role,
      hasIssue: right.hasIssue,
      issuePriority: right.issuePriority,
      releaseMatched: right.releaseMatched,
      createdAtMs: right.createdAtMs,
    },
    settings,
    nowMs,
  );
  if (leftWeight !== rightWeight) return rightWeight - leftWeight;
  if (tieBreak) {
    const tie = tieBreak(left, right);
    if (tie !== 0) return tie;
  }
  if (left.createdAtMs !== right.createdAtMs) return left.createdAtMs - right.createdAtMs;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** Score and sort a run list by priority (stable against equal scores). */
export function sortByRunPriority<T extends PriorityScoredRun>(
  runs: readonly T[],
  settings: RunPrioritySettings,
  nowMs: number = Date.now(),
): T[] {
  return [...runs].sort((left, right) => compareRunsByPriority(left, right, settings, nowMs));
}

/**
 * True when any of the run's release markers (issue labels, wake branch
 * names) carries the current release tag. An empty tag means the release
 * bonus is off.
 */
export function runMatchesCurrentRelease(
  currentRelease: string | null,
  markers: Array<string | null | undefined>,
): boolean {
  if (!currentRelease) return false;
  return markers.some((marker) => releaseTagMatches(currentRelease, marker));
}
