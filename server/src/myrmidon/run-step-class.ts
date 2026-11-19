//
// myrmidon(1.8 OPE-12996): run-step classification — the deterministic class of
// a heartbeat run derived from its wake reason and execution stage.
//
// The MODEL-BY-STEP epic picks the model per step: strong groups for review,
// acceptance and decomposition turns, economy groups for background and
// repeated runs. Everything downstream (the model lookup at run start, the
// cost report per class) reads this one verdict, so it stays pure: no DB, no
// env, no clock — the same inputs always map to the same class.
//
// Priority ladder (first match wins; later rungs never override earlier ones):
//   1. review        — the run acts as the reviewer or the review stage asked
//                      for it (stageType "review", wakeRole "reviewer",
//                      "review_pickup" source, review wake reasons). A retried
//                      review is still a verdict, so review beats retry.
//   2. acceptance    — the approval gate (stageType "approval",
//                      "execution_approval_requested").
//   3. decomposition — the accepted-plan continuation that starts execution or
//                      child decomposition (workspaceRefreshReason
//                      "accepted_plan_confirmation", or a planning issue whose
//                      "request_confirmation" interaction resolved as
//                      accepted). Mirrors acceptedPlanContinuationWake in
//                      services/heartbeat.ts.
//   4. background    — timer/monitor sweeps, goal control, empty-queue wakes,
//                      and every retry or expiry wake (retryReason set,
//                      "*_retry" wake reasons, monitor sweeps). Repeats are
//                      economy per the epic, but they never demote rungs 1-3.
//   5. execution     — the default: real task work (comments, assignment,
//                      changes-requested continuation, unblocks, pending
//                      interactions). Unknown wake reasons land here, so a
//                      future reason can only ever be over-provisioned, never
//                      silently cheapened.
//

export const RUN_STEP_CLASSES = [
  "review",
  "acceptance",
  "decomposition",
  "execution",
  "background",
] as const;

export type RunStepClass = (typeof RUN_STEP_CLASSES)[number];

/** Which priority rung classified the step; the "reason" recorded in snapshots. */
export type RunStepClassificationRule =
  | "review_stage_type"
  | "reviewer_wake_role"
  | "review_source"
  | "review_wake_reason"
  | "acceptance_stage_type"
  | "acceptance_wake_reason"
  | "accepted_plan_continuation"
  | "retry"
  | "monitor"
  | "background"
  | "default_execution";

export type RunStepClassification = {
  stepClass: RunStepClass;
  rule: RunStepClassificationRule;
};

export type RunStepClassificationInput = {
  /** contextSnapshot.wakeReason */
  wakeReason?: string | null;
  /** contextSnapshot.retryReason (or the scheduled retry reason of the run) */
  retryReason?: string | null;
  /** contextSnapshot.source */
  source?: string | null;
  /** heartbeatRuns.invocationSource */
  invocationSource?: string | null;
  /** contextSnapshot.executionStage.stageType */
  executionStageType?: string | null;
  /** contextSnapshot.executionStage.wakeRole */
  executionStageWakeRole?: string | null;
  /** issue work mode ("planning" while a plan awaits confirmation) */
  issueWorkMode?: string | null;
  /** contextSnapshot.interactionKind */
  interactionKind?: string | null;
  /** contextSnapshot.interactionStatus */
  interactionStatus?: string | null;
  /** contextSnapshot.workspaceRefreshReason */
  workspaceRefreshReason?: string | null;
};

const REVIEW_STAGE_TYPES: Record<string, true> = { review: true };
const ACCEPTANCE_STAGE_TYPES: Record<string, true> = { approval: true };
const REVIEWER_WAKE_ROLES: Record<string, true> = { reviewer: true };
const REVIEW_SOURCES: Record<string, true> = { review_pickup: true };
const REVIEW_WAKE_REASONS: Record<string, true> = {
  execution_review_requested: true,
  execution_review_participant_recovery: true,
};
const ACCEPTANCE_WAKE_REASONS: Record<string, true> = {
  execution_approval_requested: true,
};
const BACKGROUND_SOURCES: Record<string, true> = { timer: true };
const BACKGROUND_WAKE_REASONS: Record<string, true> = {
  heartbeat_timer: true,
  goal_control: true,
  dev_project_queue_empty: true,
};
// Scheduler retries and expiry sweeps, spelled out in services/heartbeat.ts.
const RETRY_WAKE_REASONS: Record<string, true> = {
  transient_failure: true,
  container_not_started: true,
  missing_issue_comment: true,
  provider_quota_recovery: true,
  deferred_issue_execution_expired: true,
  queued_run_stale_timeout: true,
};
const MONITOR_WAKE_REASON_PREFIX = "issue_monitor";
const RETRY_WAKE_REASON_SUFFIX = "_retry";
const ACCEPTED_PLAN_REFRESH_REASON = "accepted_plan_confirmation";
const PLANNING_WORK_MODE = "planning";
const CONFIRMATION_INTERACTION_KIND = "request_confirmation";
const ACCEPTED_INTERACTION_STATUS = "accepted";

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Classify one run step. Deterministic and total: every input combination
 * returns exactly one class, unknown values fall through to execution.
 */
export function classifyRunStep(
  input: RunStepClassificationInput,
): RunStepClassification {
  const wakeReason = readString(input.wakeReason);
  const retryReason = readString(input.retryReason);
  const source = readString(input.source);
  const invocationSource = readString(input.invocationSource);
  const executionStageType = readString(input.executionStageType);
  const executionStageWakeRole = readString(input.executionStageWakeRole);
  const issueWorkMode = readString(input.issueWorkMode);
  const interactionKind = readString(input.interactionKind);
  const interactionStatus = readString(input.interactionStatus);
  const workspaceRefreshReason = readString(input.workspaceRefreshReason);

  // 1. review: the actor role and the review stage beat every other signal,
  //    including retries and monitor sweeps.
  if (executionStageType && REVIEW_STAGE_TYPES[executionStageType]) {
    return { stepClass: "review", rule: "review_stage_type" };
  }
  if (executionStageWakeRole && REVIEWER_WAKE_ROLES[executionStageWakeRole]) {
    return { stepClass: "review", rule: "reviewer_wake_role" };
  }
  if (source && REVIEW_SOURCES[source]) {
    return { stepClass: "review", rule: "review_source" };
  }
  if (wakeReason && REVIEW_WAKE_REASONS[wakeReason]) {
    return { stepClass: "review", rule: "review_wake_reason" };
  }

  // 2. acceptance: the approval gate.
  if (executionStageType && ACCEPTANCE_STAGE_TYPES[executionStageType]) {
    return { stepClass: "acceptance", rule: "acceptance_stage_type" };
  }
  if (wakeReason && ACCEPTANCE_WAKE_REASONS[wakeReason]) {
    return { stepClass: "acceptance", rule: "acceptance_wake_reason" };
  }

  // 3. decomposition: the accepted-plan continuation. Same predicate as
  //    acceptedPlanContinuationWake in services/heartbeat.ts.
  if (
    workspaceRefreshReason === ACCEPTED_PLAN_REFRESH_REASON ||
    (issueWorkMode === PLANNING_WORK_MODE &&
      interactionKind === CONFIRMATION_INTERACTION_KIND &&
      interactionStatus === ACCEPTED_INTERACTION_STATUS)
  ) {
    return { stepClass: "decomposition", rule: "accepted_plan_continuation" };
  }

  // 4. background: sweeps and every retry/expiry wake.
  if (retryReason) {
    return { stepClass: "background", rule: "retry" };
  }
  if (
    wakeReason &&
    (wakeReason.endsWith(RETRY_WAKE_REASON_SUFFIX) ||
      RETRY_WAKE_REASONS[wakeReason])
  ) {
    return { stepClass: "background", rule: "retry" };
  }
  if (
    wakeReason &&
    (wakeReason.startsWith(MONITOR_WAKE_REASON_PREFIX) ||
      BACKGROUND_WAKE_REASONS[wakeReason])
  ) {
    return { stepClass: "background", rule: "monitor" };
  }
  if (
    (source && BACKGROUND_SOURCES[source]) ||
    (invocationSource && BACKGROUND_SOURCES[invocationSource])
  ) {
    return { stepClass: "background", rule: "background" };
  }

  // 5. execution: the default for real task work and unknown reasons.
  return { stepClass: "execution", rule: "default_execution" };
}

/**
 * Classify from a run's contextSnapshot (and optional issue work mode).
 * Tolerates any snapshot shape: a non-object snapshot classifies as execution.
 */
export function classifyRunStepFromContextSnapshot(
  snapshot: unknown,
  issueWorkMode?: string | null,
): RunStepClassification {
  const record =
    snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
      ? (snapshot as Record<string, unknown>)
      : {};
  const executionStage =
    record.executionStage &&
    typeof record.executionStage === "object" &&
    !Array.isArray(record.executionStage)
      ? (record.executionStage as Record<string, unknown>)
      : {};
  return classifyRunStep({
    wakeReason: readString(record.wakeReason),
    retryReason: readString(record.retryReason),
    source: readString(record.source),
    invocationSource: readString(record.invocationSource),
    executionStageType: readString(executionStage.stageType),
    executionStageWakeRole: readString(executionStage.wakeRole),
    issueWorkMode: readString(issueWorkMode),
    interactionKind: readString(record.interactionKind),
    interactionStatus: readString(record.interactionStatus),
    workspaceRefreshReason: readString(record.workspaceRefreshReason),
  });
}
