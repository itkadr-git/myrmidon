// myrmidon(OPE-12802, OPE-13077): what the retry of a run interrupted by maintenance is told.
// The retry starts a clean session and sees only pushed commits, the issue's
// comments and the continuation summary; without an instruction it redoes the
// work from zero (11.11 and 12.11: 16 runs of up to 199 calls restarted blind).
// Same carrier as the other continuations: contextSnapshot.livenessContinuationInstruction.

export const MAINTENANCE_RETRY_CONTINUATION_STATE = "maintenance_interrupt_retry";

export interface MaintenanceInterruptedRun {
  runId: string;
  windowId: string;
  /** When the interrupted run started; null when unknown. */
  startedAt?: Date | string | null;
  /** When the interrupt landed (run cancelled); null when unknown. */
  finishedAt?: Date | string | null;
  /** When the interrupted run last did something useful; null when unknown. */
  lastUsefulActionAt?: Date | string | null;
  /** The task branch, when the board knows it (issue work product / PR). */
  headBranch?: string | null;
  /** The head SHA of the task branch, when the board knows it. */
  headSha?: string | null;
}

function formatInstant(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatDurationMinutes(startedAt: string | null, finishedAt: string | null): string | null {
  if (!startedAt || !finishedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(finishedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
  const minutes = Math.round((end - start) / 60_000);
  if (minutes < 1) return "<1 min";
  if (minutes === 1) return "1 min";
  return `${minutes} min`;
}

/** Instruction for the retry: continue from what was saved, do not start over. */
export function buildMaintenanceRetryInstruction(run: MaintenanceInterruptedRun): string {
  const startedAt = formatInstant(run.startedAt);
  const finishedAt = formatInstant(run.finishedAt);
  const last = formatInstant(run.lastUsefulActionAt);
  const duration = formatDurationMinutes(startedAt, finishedAt);
  const headBranch = typeof run.headBranch === "string" && run.headBranch.trim() !== "" ? run.headBranch.trim() : null;
  const headSha = typeof run.headSha === "string" && run.headSha.trim() !== "" ? run.headSha.trim() : null;

  return [
    `Your previous run on this task was interrupted by a board rollout (run ${run.runId}, window ${run.windowId}), not by a failure.`,
    startedAt ? `Interrupted run started: ${startedAt}.` : null,
    finishedAt ? `Interrupted at: ${finishedAt}.` : null,
    duration ? `It ran for ${duration}.` : null,
    last ? `Last useful action of the interrupted run: ${last}.` : null,
    headBranch ? `Task branch: ${headBranch}.` : null,
    headSha ? `Latest commit on the branch (head SHA): ${headSha}.` : null,
    "Do not start over: run `git status` and `git log --oneline -5` in the task branch, read the task's latest comments, and continue from where the work stopped.",
    "Commit and push after every completed step.",
  ]
    .filter((line): line is string => line !== null)
    .join(" ");
}

/** The fields scheduleBoundedRetry carries into the retry's context. */
export function maintenanceRetryContinuation(run: MaintenanceInterruptedRun) {
  return {
    livenessContinuationInstruction: buildMaintenanceRetryInstruction(run),
    livenessContinuationState: MAINTENANCE_RETRY_CONTINUATION_STATE,
  };
}
