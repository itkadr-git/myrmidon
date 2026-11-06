// A run that ends because the model pool could not answer (OPE-11947).
//
// Hermes ends such a turn with its own "No reply: <model> didn't produce a
// reply ..." notice. The adapter reports it as a transient upstream failure and
// marks `resultJson.model_unavailable`. The usual transient pair (30 s, 30 s)
// is wrong for it: the pool is out of quota or down for hours, and each retry
// is a full-prompt run (~75k tokens) that spends the quota the moment it
// resets. So the retry of a model-unavailable run waits a long, growing time,
// and is not queued at all when the task no longer needs the agent.

/** First retry waits this long; each further attempt doubles it. */
export const MODEL_UNAVAILABLE_RETRY_BASE_DELAY_MS = 30 * 60 * 1000;
export const MODEL_UNAVAILABLE_RETRY_MULTIPLIER = 2;
/** 30 min -> 1 h -> 2 h -> 4 h -> 6 h; a single wait never exceeds this. */
export const MODEL_UNAVAILABLE_RETRY_MAX_DELAY_MS = 6 * 60 * 60 * 1000;
export const MODEL_UNAVAILABLE_RETRY_MAX_ATTEMPTS = 5;

/** The task still needs the agent only while it is waiting to start or being worked. */
export const MODEL_UNAVAILABLE_RETRY_ISSUE_STATUSES: readonly string[] = ["todo", "in_progress"];

/** `resultJson.model_unavailable === true`, as set by the hermes adapters. */
export function isModelUnavailableRun(run: { resultJson?: unknown }): boolean {
  const resultJson = run.resultJson;
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) return false;
  return (resultJson as Record<string, unknown>).model_unavailable === true;
}

/**
 * Whether the run can be replayed without a reconciliation hold: the adapter
 * marked it `model_unavailable` and also gave positive evidence that nothing
 * ran (`executionRecovery: bootstrap, providerWorkStarted: false`: no reply,
 * no tool call). Without that evidence the run stays on the vendor's
 * hold-and-ask path, because replaying could repeat an action.
 */
export function isReplayableModelUnavailableRun(run: { resultJson?: unknown }): boolean {
  if (!isModelUnavailableRun(run)) return false;
  const evidence = (run.resultJson as Record<string, unknown>).executionRecovery;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return false;
  const { kind, providerWorkStarted } = evidence as Record<string, unknown>;
  return kind === "bootstrap" && providerWorkStarted === false;
}

/** Delay before the 1-based `attempt`-th retry: 30 min * 2^(attempt-1), capped at 6 h. */
export function computeModelUnavailableRetryDelayMs(attempt: number): number {
  const n = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  return Math.min(
    MODEL_UNAVAILABLE_RETRY_BASE_DELAY_MS * Math.pow(MODEL_UNAVAILABLE_RETRY_MULTIPLIER, n - 1),
    MODEL_UNAVAILABLE_RETRY_MAX_DELAY_MS,
  );
}

export type ModelUnavailableRetryIssueDecision =
  | { allowed: true }
  | {
      allowed: false;
      errorCode: "issue_not_found" | "issue_reassigned" | "issue_not_in_progress";
      reason: string;
      details: Record<string, unknown>;
    };

/**
 * Whether the issue a model-unavailable run worked on still wants a retry from
 * the same agent: it exists, is still assigned to that agent, and is in `todo`
 * or `in_progress`. `backlog`, `blocked`, `in_review` and terminal tasks are
 * not retried.
 */
export function decideModelUnavailableRetryIssue(input: {
  issueId: string;
  runAgentId: string;
  issue: { status: string; assigneeAgentId: string | null } | null;
}): ModelUnavailableRetryIssueDecision {
  const { issueId, runAgentId, issue } = input;
  if (!issue) {
    return {
      allowed: false,
      errorCode: "issue_not_found",
      reason: "Model-unavailable retry suppressed because the target issue no longer exists",
      details: { issueId },
    };
  }
  if (issue.assigneeAgentId !== runAgentId) {
    return {
      allowed: false,
      errorCode: "issue_reassigned",
      reason: "Model-unavailable retry suppressed because issue ownership changed",
      details: {
        issueId,
        previousAssigneeAgentId: runAgentId,
        currentAssigneeAgentId: issue.assigneeAgentId,
      },
    };
  }
  if (!MODEL_UNAVAILABLE_RETRY_ISSUE_STATUSES.includes(issue.status)) {
    return {
      allowed: false,
      errorCode: "issue_not_in_progress",
      reason: `Model-unavailable retry suppressed because issue is not todo or in_progress (current status: ${issue.status})`,
      details: {
        issueId,
        currentStatus: issue.status,
        requiredStatuses: [...MODEL_UNAVAILABLE_RETRY_ISSUE_STATUSES],
      },
    };
  }
  return { allowed: true };
}
