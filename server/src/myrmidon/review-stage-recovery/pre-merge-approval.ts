// myrmidon(OPE-10045): an approval of the last review stage given before the
// pull request is merged.
//
// The reviewer approves with `PATCH status=done` and a comment. While the PR is
// still open the done gate (`issue_done_pull_request_gate`) refused the whole
// update, so the decision was lost, the stage stayed pending and recovery later
// blocked the task. Now the route records the decision, completes the stage,
// keeps the task `in_review` and answers 200 with the notice below; the PR sync
// closes the task once the PR is merged.

import { and, eq } from "drizzle-orm";
import { issueWorkProducts, type Db } from "@myrmidon/db";
import { selectOpenPullRequestWorkProduct } from "./policy.js";

export const REVIEW_APPROVAL_PENDING_MERGE_CODE = "review_approval_pending_merge";

export interface ReviewApprovalPendingMergeNotice {
  code: typeof REVIEW_APPROVAL_PENDING_MERGE_CODE;
  recorded: true;
  pendingMerge: true;
  pullRequestUrl: string | null;
  message: string;
}

/** True for a final approval that asks for `done` on an issue that is not closed yet. */
export function isApprovalRequestingDone(input: {
  decisionOutcome: string | null | undefined;
  requestedStatus: unknown;
  existingStatus: string;
}): boolean {
  return input.decisionOutcome === "approved" && input.requestedStatus === "done" && input.existingStatus !== "done";
}

export function buildReviewApprovalPendingMergeNotice(pullRequestUrl: string | null): ReviewApprovalPendingMergeNotice {
  const target = pullRequestUrl ?? "the linked pull request";
  return {
    code: REVIEW_APPROVAL_PENDING_MERGE_CODE,
    recorded: true,
    pendingMerge: true,
    pullRequestUrl,
    message:
      `Одобрение записано, задача закроется после слияния ${target}. ` +
      `Approval recorded: the review stage is complete and the task closes when ${target} is merged.`,
  };
}

/** The open pull request that keeps the done gate closed for this issue, if any (stored facts only, no GitHub call). */
export async function findApprovalPendingMergePullRequest(
  db: Pick<Db, "select">,
  companyId: string,
  issueId: string,
): Promise<{ id: string; url: string | null } | null> {
  const rows = await db
    .select({
      id: issueWorkProducts.id,
      type: issueWorkProducts.type,
      status: issueWorkProducts.status,
      url: issueWorkProducts.url,
      isPrimary: issueWorkProducts.isPrimary,
      updatedAt: issueWorkProducts.updatedAt,
    })
    .from(issueWorkProducts)
    .where(
      and(
        eq(issueWorkProducts.companyId, companyId),
        eq(issueWorkProducts.issueId, issueId),
        eq(issueWorkProducts.type, "pull_request"),
      ),
    );
  const product = selectOpenPullRequestWorkProduct(Array.isArray(rows) ? rows : []);
  return product ? { id: product.id, url: product.url ?? null } : null;
}
