// myrmidon(REVIEW-ROUTING): the pure decisions of the review routing — which
// tasks need a reviewer, who may be picked, what the stage patch looks like.
// No database and no clock here; the sweep feeds these functions.

import { randomUUID } from "node:crypto";
import type { IssueExecutionPolicy } from "@paperclipai/shared";
import { applyIssueExecutionPolicyTransition } from "../../services/issue-execution-policy.js";

export interface RoutingIssue {
  id: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  responsibleUserId?: string | null;
  executionPolicy: unknown;
  executionState: unknown;
  // myrmidon(HUMAN-REVIEW-WAIT): a declared human-only wait is never routed to
  // an agent reviewer — the verdict belongs to a person by policy.
  reviewPolicy?: string | null;
}

export interface ReviewerCandidate {
  id: string;
  role: string;
  /** Tasks the agent holds in flight (in progress + in review). */
  load: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function policyStages(policy: unknown): Array<Record<string, unknown>> {
  const stages = asRecord(policy)?.stages;
  return Array.isArray(stages) ? stages.filter((s): s is Record<string, unknown> => asRecord(s) !== null) : [];
}

/** True when the policy carries at least one stage with at least one participant. */
export function policyHasReviewerParticipant(policy: unknown): boolean {
  return policyStages(policy).some((stage) => Array.isArray(stage.participants) && stage.participants.length > 0);
}

/**
 * A task that is in review with no reviewer: it has no stage participant at
 * all, and no execution workflow in flight. A policy with no stages (it may
 * still carry the trust boundary or a review preset) is kept and extended; a
 * non-idle execution state or a monitor means a workflow this routing does not
 * own, and the task is left alone.
 */
export function issueNeedsReviewer(issue: RoutingIssue): boolean {
  if (issue.status !== "in_review") return false;
  // myrmidon(HUMAN-REVIEW-WAIT): see the RoutingIssue field.
  if (issue.reviewPolicy === "human_only") return false;
  if (policyHasReviewerParticipant(issue.executionPolicy)) return false;
  const state = asRecord(issue.executionState);
  if (state) {
    if (typeof state.status === "string" && state.status !== "idle") return false;
    if (state.monitor != null) return false;
  }
  return true;
}

export interface PendingAgentReview {
  stageId: string;
  reviewerAgentId: string;
  returnAssigneeAgentId: string | null;
}

/** The pending review stage held by an agent reviewer, or null. */
export function readPendingAgentReview(issue: RoutingIssue): PendingAgentReview | null {
  if (issue.status !== "in_review") return null;
  const state = asRecord(issue.executionState);
  if (!state || state.status !== "pending" || state.currentStageType !== "review") return null;
  const participant = asRecord(state.currentParticipant);
  if (!participant || participant.type !== "agent" || typeof participant.agentId !== "string") return null;
  if (typeof state.currentStageId !== "string") return null;
  const returnAssignee = asRecord(state.returnAssignee);
  return {
    stageId: state.currentStageId,
    reviewerAgentId: participant.agentId,
    returnAssigneeAgentId:
      returnAssignee && returnAssignee.type === "agent" && typeof returnAssignee.agentId === "string"
        ? returnAssignee.agentId
        : null,
  };
}

/** Whole hours elapsed since `since`, or 0 when it is in the future. */
export function hoursSince(since: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - since.getTime()) / 3_600_000));
}

/** True when the review has been waiting at least `afterHours` (0 disables). */
export function isReviewOverdue(input: { since: Date; now: Date; afterHours: number }): boolean {
  return input.afterHours > 0 && input.now.getTime() - input.since.getTime() >= input.afterHours * 3_600_000;
}

/** Agent ids that must never review this task: its author, its assignee, and `extra`. */
export function excludedReviewerIds(issue: RoutingIssue, extra: Iterable<string> = []): Set<string> {
  const excluded = new Set<string>(extra);
  if (issue.createdByAgentId) excluded.add(issue.createdByAgentId);
  if (issue.assigneeAgentId) excluded.add(issue.assigneeAgentId);
  return excluded;
}

/**
 * Least-loaded eligible reviewer. Candidates at or above `maxLoad` and
 * excluded ids are skipped; ties break by id so the choice is deterministic.
 */
export function pickReviewer(input: {
  candidates: readonly ReviewerCandidate[];
  excluded: ReadonlySet<string>;
  maxLoad: number;
}): ReviewerCandidate | null {
  const eligible = input.candidates.filter(
    (candidate) => !input.excluded.has(candidate.id) && candidate.load < input.maxLoad,
  );
  if (eligible.length === 0) return null;
  return [...eligible].sort((a, b) => a.load - b.load || a.id.localeCompare(b.id))[0] ?? null;
}

export const REVIEW_ROUTING_REVIEW_INSTRUCTIONS =
  "Automatic review routing: this task was in review with no reviewer. Approve only if the work is " +
  "complete and correct (that closes the task as done); request changes to send it back to the " +
  "assignee with what still needs to happen.";

/**
 * Builds the patch that gives a reviewer-less `in_review` task a one-stage
 * review with `reviewerAgentId`, through the vendor's own execution-policy
 * transition so the result is the normal review stage the rest of the product
 * understands (the reviewer becomes the assignee while the review is pending;
 * the original assignee is the return assignee).
 */
export function buildReviewRoutingAssignPatch(input: {
  issue: RoutingIssue;
  reviewerAgentId: string;
}): Record<string, unknown> {
  const existing = asRecord(input.issue.executionPolicy);
  const policy = {
    ...(existing ?? { mode: "normal", commentRequired: false }),
    stages: [
      {
        id: randomUUID(),
        type: "review",
        approvalsNeeded: 1,
        participants: [{ id: randomUUID(), type: "agent", agentId: input.reviewerAgentId, userId: null }],
      },
    ],
  } as unknown as IssueExecutionPolicy;
  const transition = applyIssueExecutionPolicyTransition({
    issue: {
      status: input.issue.status,
      assigneeAgentId: input.issue.assigneeAgentId,
      assigneeUserId: input.issue.assigneeUserId,
      responsibleUserId: input.issue.responsibleUserId ?? null,
      createdByUserId: input.issue.createdByUserId ?? null,
      executionPolicy: null,
      executionState: null,
    },
    policy,
    previousPolicy: null,
    requestedStatus: "in_review",
    requestedAssigneePatch: {},
    actor: { agentId: null, userId: null },
    reviewRequest: { instructions: REVIEW_ROUTING_REVIEW_INSTRUCTIONS },
  });
  const patch: Record<string, unknown> = { ...transition.patch, executionPolicy: policy };
  // A task with no assignee has no return assignee, and "request changes"
  // would then have nowhere to send it back: fall back to the task's author.
  const state = asRecord(patch.executionState);
  if (state && !state.returnAssignee) {
    if (input.issue.createdByAgentId) {
      state.returnAssignee = { type: "agent", agentId: input.issue.createdByAgentId, userId: null };
    } else if (input.issue.createdByUserId) {
      state.returnAssignee = { type: "user", userId: input.issue.createdByUserId, agentId: null };
    }
  }
  return patch;
}

/**
 * Builds the patch that moves a pending review to another agent reviewer: the
 * stage keeps its id and state (round counter, request, return assignee), only
 * the participant and the assignee change.
 */
export function buildReviewRoutingReassignPatch(input: {
  issue: RoutingIssue;
  newReviewerAgentId: string;
}): Record<string, unknown> | null {
  const pending = readPendingAgentReview(input.issue);
  const state = asRecord(input.issue.executionState);
  if (!pending || !state) return null;
  const policy = asRecord(input.issue.executionPolicy);
  if (!policy) return null;
  const participant = { id: randomUUID(), type: "agent", agentId: input.newReviewerAgentId, userId: null };
  const stages = policyStages(policy).map((stage) =>
    stage.id === pending.stageId ? { ...stage, participants: [participant] } : stage,
  );
  return {
    executionPolicy: { ...policy, stages },
    executionState: {
      ...state,
      currentParticipant: { type: "agent", agentId: input.newReviewerAgentId, userId: null },
    },
    assigneeAgentId: input.newReviewerAgentId,
    assigneeUserId: null,
  };
}

export interface ReviewRoutingWakeContext {
  wakeRole: "reviewer";
  stageId: string | null;
  stageType: string | null;
  currentParticipant: unknown;
  returnAssignee: unknown;
  reviewRequest: unknown;
  lastDecisionOutcome: unknown;
  allowedActions: string[];
}

/** Mirrors the vendor's review wake context, read off the state this module persisted. */
export function buildReviewRoutingWakeContext(executionState: Record<string, unknown>): ReviewRoutingWakeContext {
  return {
    wakeRole: "reviewer",
    stageId: typeof executionState.currentStageId === "string" ? executionState.currentStageId : null,
    stageType: typeof executionState.currentStageType === "string" ? executionState.currentStageType : null,
    currentParticipant: executionState.currentParticipant ?? null,
    returnAssignee: executionState.returnAssignee ?? null,
    reviewRequest: executionState.reviewRequest ?? null,
    lastDecisionOutcome: executionState.lastDecisionOutcome ?? null,
    allowedActions: ["approve", "request_changes"],
  };
}
