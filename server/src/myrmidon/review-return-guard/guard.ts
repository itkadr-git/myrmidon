// myrmidon(OPE-11970, REVIEW-RETURN-GUARD): the decision whether a review
// return wakes the executor, and the record of a return that does not.
// Policy (pure): ./policy.ts. The PATCH route wires the real GitHub reader,
// the issue comment writer and the activity log into the ports below.

import type { ReviewHeadFailedChecksResolver } from "../review-stage-recovery/github-ci.js";
import {
  CI_INFRA_RETRY_NEEDED_ACTION,
  REVIEW_RETURN_SUPPRESSED_ACTION,
  buildReviewReturnSuppressedNote,
  failedChecksAreInfraOnly,
  isCiOnlyReviewComment,
  normalizeHeadSha,
  repeatedReturnHead,
  type ReviewReturnWakeDecision,
} from "./policy.js";

type StateWithHead = {
  status?: string | null;
  lastChangesRequestedHeadSha?: string | null;
} | null | undefined;

export interface ReviewReturnGuardInput {
  enabled: boolean;
  companyId: string;
  issueId: string;
  /** The execution state before the review decision. */
  previousState: StateWithHead;
  /** The execution state the decision wrote (`changes_requested`, with the head of the decision). */
  nextState: StateWithHead;
  /** The comment the reviewer sent with the decision. */
  commentBody: string | null | undefined;
  /** Check names whose failure does not say anything about the code. */
  infraCheckNames: readonly string[];
}

export interface ReviewReturnGuardDeps {
  resolveFailedChecks: ReviewHeadFailedChecksResolver;
}

/**
 * Whether the executor is woken for a review return (`changes_requested`).
 * Every read that fails, and every doubt, answers `wake`: the guard only ever
 * removes a wake it can prove useless.
 */
export async function decideReviewReturnWake(
  input: ReviewReturnGuardInput,
  deps: ReviewReturnGuardDeps,
): Promise<ReviewReturnWakeDecision> {
  if (!input.enabled) return { action: "wake" };
  const next = input.nextState;
  if (!next || next.status !== "changes_requested") return { action: "wake" };

  const repeatedHead = repeatedReturnHead(input.previousState, next);
  if (repeatedHead) return { action: "suppress", reason: "repeat_same_head", headSha: repeatedHead };

  const headSha = normalizeHeadSha(next.lastChangesRequestedHeadSha);
  if (!headSha) return { action: "wake" };
  if (input.infraCheckNames.length === 0) return { action: "wake" };
  if (!isCiOnlyReviewComment(input.commentBody)) return { action: "wake" };

  let checks: Awaited<ReturnType<ReviewHeadFailedChecksResolver>>;
  try {
    checks = await deps.resolveFailedChecks({ companyId: input.companyId, issueId: input.issueId, headSha });
  } catch {
    return { action: "wake" };
  }
  if (checks.state !== "ok") return { action: "wake" };
  if (!failedChecksAreInfraOnly(checks.failed, input.infraCheckNames)) return { action: "wake" };
  return {
    action: "suppress",
    reason: "ci_infra_only",
    headSha,
    failedChecks: checks.failed,
    pullRequestUrl: checks.pullRequestUrl,
  };
}

export interface SuppressedReturnRecordPorts {
  /** A system-authored comment in the task thread; it wakes nobody. */
  addSystemComment(issueId: string, body: string): Promise<unknown>;
  logActivity(entry: {
    companyId: string;
    action: string;
    entityId: string;
    details: Record<string, unknown>;
  }): Promise<unknown>;
}

/**
 * Leaves the trace of a return that did not wake the executor: a short note in
 * the task thread and an activity row. An infrastructure-only return also gets
 * the `ci_infra_retry_needed` row that the release tooling reads to re-run the
 * failed jobs. A failed write is not an error of the review decision, which is
 * already committed; the caller logs it.
 */
export async function recordSuppressedReviewReturn(
  ports: SuppressedReturnRecordPorts,
  input: {
    companyId: string;
    issueId: string;
    identifier?: string | null;
    decisionId?: string | null;
    decision: Exclude<ReviewReturnWakeDecision, { action: "wake" }>;
  },
): Promise<void> {
  const { decision } = input;
  await ports.addSystemComment(input.issueId, buildReviewReturnSuppressedNote(decision));
  const common = {
    issueId: input.issueId,
    identifier: input.identifier ?? null,
    decisionId: input.decisionId ?? null,
    headSha: decision.headSha,
    reason: decision.reason,
  };
  await ports.logActivity({
    companyId: input.companyId,
    action: REVIEW_RETURN_SUPPRESSED_ACTION,
    entityId: input.issueId,
    details: decision.reason === "ci_infra_only" ? { ...common, failedChecks: decision.failedChecks } : common,
  });
  if (decision.reason === "ci_infra_only") {
    await ports.logActivity({
      companyId: input.companyId,
      action: CI_INFRA_RETRY_NEEDED_ACTION,
      entityId: input.issueId,
      details: {
        ...common,
        failedChecks: decision.failedChecks,
        pullRequestUrl: decision.pullRequestUrl,
      },
    });
  }
}
