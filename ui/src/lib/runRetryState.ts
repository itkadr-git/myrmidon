import { formatDateTime } from "./utils";

type RetryAwareRun = {
  status: string;
  retryOfRunId?: string | null;
  scheduledRetryAt?: string | Date | null;
  scheduledRetryAttempt?: number | null;
  scheduledRetryReason?: string | null;
  retryExhaustedReason?: string | null;
  /**
   * myrmidon(1.6.6 RUN-RETRY-POLICY): the attempt ceiling and the failure class
   * the scheduler recorded. Absent on runs queued before the policy existed.
   */
  scheduledRetryMaxAttempts?: number | null;
  scheduledRetryClassification?: string | null;
};

export type RunRetryStateSummary = {
  kind: "scheduled" | "exhausted" | "attempted";
  badgeLabel: string;
  tone: string;
  detail: string | null;
  secondary: string | null;
  retryOfRunId: string | null;
};

const RETRY_REASON_LABELS: Record<string, string> = {
  transient_failure: "Transient failure",
  missing_issue_comment: "Missing task comment",
  process_lost: "Process lost",
  assignment_recovery: "Assignment recovery",
  issue_continuation_needed: "Continuation needed",
  max_turns_continuation: "Max-turn continuation",
};

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function joinFragments(parts: Array<string | null>) {
  const filtered = parts.filter((part): part is string => Boolean(part));
  return filtered.length > 0 ? filtered.join(" · ") : null;
}

export function formatRetryReason(reason: string | null | undefined) {
  const normalized = readNonEmptyString(reason);
  if (!normalized) return null;
  return RETRY_REASON_LABELS[normalized] ?? normalized.replace(/_/g, " ");
}

const RETRY_CLASSIFICATION_LABELS: Record<string, string> = {
  transient: "Transient failure",
  permanent: "Permanent failure",
  unknown: "Unclassified failure",
};

/**
 * myrmidon(1.6.6 RUN-RETRY-POLICY): "Attempt 2 of 3" when the scheduler recorded
 * the ceiling, plain "Attempt 2" otherwise — retries queued before the policy
 * existed carry no ceiling and must keep rendering as they did.
 */
export function formatRetryAttemptCounter(
  attempt: number | null | undefined,
  maxAttempts?: number | null,
): string | null {
  const value = readPositiveInt(attempt);
  if (value === null) return null;
  const limit = readPositiveInt(maxAttempts);
  return limit === null ? `Attempt ${value}` : `Attempt ${value} of ${limit}`;
}

/** Human label of the failure class behind a retry, when the policy recorded it. */
export function formatRetryClassification(
  classification: string | null | undefined,
): string | null {
  const normalized = readNonEmptyString(classification);
  if (!normalized) return null;
  return RETRY_CLASSIFICATION_LABELS[normalized] ?? normalized.replace(/_/g, " ");
}

function readPositiveInt(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

export function describeRunRetryState(run: RetryAwareRun): RunRetryStateSummary | null {
  const attempt = readPositiveInt(run.scheduledRetryAttempt);
  // myrmidon(1.6.6 RUN-RETRY-POLICY): the counter names the ceiling the
  // scheduler enforced, and the class of the failure behind the retry, when the
  // schedule recorded them.
  const attemptLabel = formatRetryAttemptCounter(attempt, run.scheduledRetryMaxAttempts);
  const classificationLabel = formatRetryClassification(run.scheduledRetryClassification);
  const reasonLabel = formatRetryReason(run.scheduledRetryReason);
  // The retry reason and the failure class often say the same thing
  // ("transient_failure" is a transient failure); say it once.
  const classificationFragment =
    classificationLabel === reasonLabel ? null : classificationLabel;
  const retryOfRunId = readNonEmptyString(run.retryOfRunId);
  const exhaustedReason = readNonEmptyString(run.retryExhaustedReason);
  const dueAt = run.scheduledRetryAt ? formatDateTime(run.scheduledRetryAt) : null;
  const isMaxTurnContinuation = run.scheduledRetryReason === "max_turns_continuation";
  const hasRetryMetadata =
    Boolean(retryOfRunId)
    || Boolean(reasonLabel)
    || Boolean(dueAt)
    || Boolean(attemptLabel)
    || Boolean(classificationFragment)
    || Boolean(exhaustedReason);

  if (!hasRetryMetadata) return null;

  if (run.status === "scheduled_retry") {
    return {
      kind: "scheduled",
      badgeLabel: isMaxTurnContinuation ? "Continuation scheduled" : "Retry scheduled",
      tone: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
      detail: joinFragments([attemptLabel, reasonLabel, classificationFragment]),
      secondary: dueAt
        ? `${isMaxTurnContinuation ? "Next continuation" : "Next retry"} ${dueAt}`
        : `${isMaxTurnContinuation ? "Next continuation" : "Next retry"} pending schedule`,
      retryOfRunId,
    };
  }

  if (exhaustedReason) {
    return {
      kind: "exhausted",
      badgeLabel: isMaxTurnContinuation ? "Continuation exhausted" : "Retry exhausted",
      tone: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      detail: joinFragments([attemptLabel, reasonLabel, classificationFragment, "Automatic retries exhausted"]),
      secondary: exhaustedReason.includes("Manual intervention required")
        ? exhaustedReason
        : `${exhaustedReason} Manual intervention required.`,
      retryOfRunId,
    };
  }

  return {
    kind: "attempted",
    badgeLabel: isMaxTurnContinuation ? "Continued run" : "Retried run",
    tone: "border-slate-500/20 bg-slate-500/10 text-slate-700 dark:text-slate-300",
    detail: joinFragments([attemptLabel, reasonLabel, classificationFragment]),
    secondary: null,
    retryOfRunId,
  };
}
