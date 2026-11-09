// myrmidon(OPE-11767): the event half of the board-side merge.
//
// Two places in the board already learn the moment a merge may become due: a
// review stage approved (`triggerReviewApprovalPropagation`) and a CI run of a
// pull request completed (`applyCiCompletionEvent` of the GitHub connection
// events). Neither may import the review-routing sweep (a static import cycle
// through the service barrel), so they only announce the event here; the
// review-routing scheduler registers the one listener that turns it into a
// merge evaluation. Without a listener — a test, a process that does not run
// the scheduler, the merge switched off — an announcement is a no-op, and the
// periodic sweep stays the safety net that finds the same PR on its own.

export type BoardMergeTriggerSource = "review_approved" | "ci_completed";

export interface BoardMergeTriggerEvent {
  companyId: string;
  /** The approved task (approval events). */
  issueId?: string | null;
  /** The pull request whose CI completed (CI events). */
  repository?: string | null;
  number?: number | null;
  headSha?: string | null;
  source: BoardMergeTriggerSource;
}

export type BoardMergeTriggerListener = (event: BoardMergeTriggerEvent) => Promise<unknown> | unknown;

let listener: BoardMergeTriggerListener | null = null;

/** Registers (or, with null, removes) the single listener of the process. */
export function setBoardMergeTrigger(next: BoardMergeTriggerListener | null): void {
  listener = next;
}

/** Announces an event. Never throws and never waits: the caller's own work is not delayed by a merge. */
export function notifyBoardMergeTrigger(event: BoardMergeTriggerEvent): void {
  const current = listener;
  if (!current) return;
  try {
    void Promise.resolve(current(event)).catch(() => undefined);
  } catch {
    // A listener fault must never break the approval or the CI event that announced it.
  }
}
