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
import { issueWorkProducts, issues, issueComments, type Db } from "@myrmidon/db";
import { selectOpenPullRequestWorkProduct, OPEN_PULL_REQUEST_WORK_PRODUCT_STATUSES } from "./policy.js";

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
      metadata: issueWorkProducts.metadata,
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
  if (product) {
    return { id: product.id, url: product.url ?? null };
  }

  // Fallback: search open PRs in company by branch bot/<KEY> or "APPROVE PR #N" in comments
  const [issueRow] = await db
    .select({ identifier: issues.identifier })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));

  if (!issueRow) return null;

  const key = issueRow.identifier;
  const targetBranch = `bot/${key}`;

  const companyPrRows = await db
    .select({
      id: issueWorkProducts.id,
      type: issueWorkProducts.type,
      status: issueWorkProducts.status,
      url: issueWorkProducts.url,
      isPrimary: issueWorkProducts.isPrimary,
      updatedAt: issueWorkProducts.updatedAt,
      metadata: issueWorkProducts.metadata,
    })
    .from(issueWorkProducts)
    .where(
      and(
        eq(issueWorkProducts.companyId, companyId),
        eq(issueWorkProducts.type, "pull_request"),
      ),
    );

  const openPrs = (Array.isArray(companyPrRows) ? companyPrRows : []).filter(
    (p) => OPEN_PULL_REQUEST_WORK_PRODUCT_STATUSES.has(p.status),
  );

  const branchMatch = openPrs.find((p) => {
    const meta = (p.metadata && typeof p.metadata === "object" ? p.metadata : {}) as Record<string, unknown>;
    const branch = String(meta.branch ?? meta.headRefName ?? meta.headBranch ?? "");
    return branch === targetBranch;
  });

  if (branchMatch) {
    return { id: branchMatch.id, url: branchMatch.url ?? null };
  }

  const commentRows = await db
    .select({ body: issueComments.body })
    .from(issueComments)
    .where(and(eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId)));

  const approveRegex = /APPROVE\s+PR\s+#(\d+)/i;
  for (const c of commentRows) {
    const match = c.body?.match(approveRegex);
    if (match && match[1]) {
      const prNum = Number(match[1]);
      const prMatch = openPrs.find((p) => {
        const meta = (p.metadata && typeof p.metadata === "object" ? p.metadata : {}) as Record<string, unknown>;
        const num = Number(meta.number ?? meta.pullRequestNumber ?? NaN);
        if (num === prNum) return true;
        if (p.url && p.url.endsWith(`/${prNum}`)) return true;
        if (p.url && p.url.includes(`/pull/${prNum}`)) return true;
        return false;
      });
      if (prMatch) {
        return { id: prMatch.id, url: prMatch.url ?? null };
      }
    }
  }

  return null;
}
