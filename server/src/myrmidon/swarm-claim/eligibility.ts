// server/src/myrmidon/swarm-claim/eligibility.ts
//
// myrmidon(1.6.6 SWARM-B): the pure half of the matcher's "can this executor take
// another task" reading. The matcher reads persisted facts (agent rows, run and
// wake-request rows, assignments, leases) and hands them here; nothing in this
// file touches the clock or the database, so every rule below is pinned by a plain
// unit test.
//
//   * load      - the open tasks an agent already carries: assigned `todo` and
//                 `in_progress` tasks plus live leases, counted once per task. A
//                 lease on a task that is also assigned to the agent is one task.
//   * pause     - `agents.status = 'paused'` or `agents.paused_at` set. Paused until
//                 somebody resumes the agent; a heartbeat never lifts it.
//   * quota     - a provider quota failure recorded on a run (`error_code =
//                 'provider_quota'`, or the text "Individual quota ..." in the run
//                 or wake-request error) holds the agent until the reset the failure
//                 recorded, else until a default backoff after the failure. A run that
//                 succeeded AFTER the failure lifts the hold. A failure of any other
//                 kind is not a quota fact and never holds anyone.

/** The assigned statuses that occupy an executor (`todo` is a reservation). */
export const SWARM_LOAD_ISSUE_STATUSES = ["todo", "in_progress"] as const;

/** How long a quota failure with no recorded reset holds the agent. */
export const SWARM_QUOTA_DEFAULT_HOLD_MS = 60 * 60 * 1000;

/** A recorded reset further away than this after the failure is not believed. */
export const SWARM_QUOTA_MAX_HOLD_MS = 7 * 24 * 60 * 60 * 1000;

/** The text a provider puts on an exhausted per-user quota. */
export const SWARM_INDIVIDUAL_QUOTA_TEXT = "individual quota";
export const SWARM_INDIVIDUAL_QUOTA_RE = new RegExp(SWARM_INDIVIDUAL_QUOTA_TEXT, "i");

/** Facts loaded by the caller using the shared blocker/hold predicates. */
export interface IssueReadinessFacts {
  hasOpenBlocker: boolean;
  onHold: boolean;
  hasProjectOrCaste: boolean;
  assignmentCompatible: boolean;
}

export type IssueNotReadyReason = "open_blocker" | "on_hold" | "missing_project_or_caste" | "incompatible_assignment";
export type IssueReadiness = { ready: true; reason: null } | { ready: false; reason: IssueNotReadyReason };

/** Pure decision function; callers obtain blocker and hold facts from shared predicates. */
export function isIssueReady(facts: IssueReadinessFacts): IssueReadiness {
  if (facts.hasOpenBlocker) return { ready: false, reason: "open_blocker" };
  if (facts.onHold) return { ready: false, reason: "on_hold" };
  if (!facts.hasProjectOrCaste) return { ready: false, reason: "missing_project_or_caste" };
  if (!facts.assignmentCompatible) return { ready: false, reason: "incompatible_assignment" };
  return { ready: true, reason: null };
}

/** Open load: distinct task ids across assignments and live leases. */
export function openLoadOf(
  assignedIssueIds: Iterable<string>,
  leasedIssueIds: Iterable<string>,
): number {
  const ids = new Set<string>();
  for (const id of assignedIssueIds) ids.add(id);
  for (const id of leasedIssueIds) ids.add(id);
  return ids.size;
}

/** The persisted facts of one agent row that decide the pause. */
export interface SwarmAgentPauseFacts {
  status: string | null;
  pausedAt: Date | string | null | undefined;
}

/** True while the agent is paused. Never inferred from a heartbeat. */
export function isAgentPaused(facts: SwarmAgentPauseFacts): boolean {
  if (facts.status === "paused") return true;
  return facts.pausedAt !== null && facts.pausedAt !== undefined;
}

/** One recorded failure that may be a quota fact (a run or a wake request). */
export interface SwarmQuotaFailureFact {
  /** `heartbeat_runs.error_code`; null for a wake request. */
  errorCode: string | null;
  /** The error text of the run or of the wake request. */
  error: string | null;
  /** `result_json` of the run; null for a wake request. */
  resultJson: Record<string, unknown> | null;
  /** When the failure was recorded (`finished_at`, else `created_at`). */
  occurredAt: Date;
}

function readDate(value: unknown): Date | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Whether a failure fact is a quota failure at all. */
export function isQuotaFailure(fact: SwarmQuotaFailureFact): boolean {
  if (fact.errorCode === "provider_quota") return true;
  if (fact.error && SWARM_INDIVIDUAL_QUOTA_RE.test(fact.error)) return true;
  const result = fact.resultJson;
  return Boolean(result && readDate(result.providerQuotaRetryNotBefore));
}

/** The moment the failure says the quota comes back (or the default hold). */
export function quotaResetAt(fact: SwarmQuotaFailureFact): Date {
  const result = fact.resultJson;
  const recorded =
    readDate(result?.providerQuotaRetryNotBefore) ??
    readDate(result?.retryNotBefore) ??
    readDate(result?.transientRetryNotBefore);
  const fallback = new Date(fact.occurredAt.getTime() + SWARM_QUOTA_DEFAULT_HOLD_MS);
  if (!recorded) return fallback;
  const ceiling = new Date(fact.occurredAt.getTime() + SWARM_QUOTA_MAX_HOLD_MS);
  return recorded.getTime() > ceiling.getTime() ? ceiling : recorded;
}

/**
 * Until when the agent is held by a quota failure, or null when it is not.
 * `lastSuccessAt` is the newest succeeded run of the agent: a success after a
 * failure proves the quota is back, so that failure holds nothing.
 */
export function quotaHoldUntil(input: {
  failures: readonly SwarmQuotaFailureFact[];
  lastSuccessAt: Date | null;
  now: Date;
}): Date | null {
  let until: Date | null = null;
  for (const fact of input.failures) {
    if (!isQuotaFailure(fact)) continue;
    if (input.lastSuccessAt && input.lastSuccessAt.getTime() > fact.occurredAt.getTime()) continue;
    const reset = quotaResetAt(fact);
    if (reset.getTime() <= input.now.getTime()) continue;
    if (!until || reset.getTime() > until.getTime()) until = reset;
  }
  return until;
}
