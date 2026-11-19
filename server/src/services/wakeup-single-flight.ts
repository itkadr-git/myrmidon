// myrmidon(1.8 HIBERNATE, OPE-12961): single-flight guard for wakeups.
// Two enqueues of the same wake racing while the first is still in flight
// (before either run row is registered) collapse into one promise, so an
// idle-stopped container agent is not cold-started twice for one task and
// the queued task keeps its single wake. Extracted as a pure helper so the
// guard is unit-testable without booting the heartbeat service.
export type WakeupSingleFlightKeyOptions = {
  idempotencyKey?: string | null;
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  contextSnapshot?: Record<string, unknown> | null;
};

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function wakeupSingleFlightKey(
  agentId: string,
  opts: WakeupSingleFlightKeyOptions = {},
): string {
  const issueId =
    readNonEmptyString(opts.contextSnapshot?.issueId) ??
    readNonEmptyString(opts.payload?.issueId) ??
    "none";
  // myrmidon(1.8 HIBERNATE, OPE-12961): a wake tied to a specific comment is
  // causally distinct from another comment's wake on the same issue — only
  // comment-less wakes of the same issue and reason merge.
  const wakeCommentId =
    readNonEmptyString(opts.payload?.wakeCommentId) ??
    readNonEmptyString(opts.contextSnapshot?.wakeCommentId);
  return `agent:${agentId}:issue:${issueId}:reason:${opts.reason ?? "none"}${
    opts.idempotencyKey ? `:key:${opts.idempotencyKey}` : ""
  }${wakeCommentId ? `:comment:${wakeCommentId}` : ""}`;
}

export class WakeupSingleFlight {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  run<T>(key: string, start: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;
    const promise = start();
    this.inFlight.set(key, promise);
    // The guard entry must clear in the same microtask batch as settlement,
    // BEFORE any caller's own await continuation resumes: this continuation
    // is registered directly on the promise, so it is queued ahead of a
    // caller's later await. A re-wake that arrives right after the wake
    // settles then starts a new wake instead of silently collapsing onto the
    // settled one (a trailing .catch().finally() chain settles one microtask
    // late and swallowed such re-wakes).
    void promise.then(
      () => {
        if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
      },
      () => {
        if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
      },
    );
    return promise;
  }

  has(key: string): boolean {
    return this.inFlight.has(key);
  }

  get size(): number {
    return this.inFlight.size;
  }
}
