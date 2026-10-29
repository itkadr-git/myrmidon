import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { issueWorkProducts } from "@myrmidon/db";
import type { PullRequestHeadResolver } from "../../myrmidon/review-routing/github.js";

export interface IsIssueWaitingForPullRequestCiParams {
  companyId: string;
  issueId: string;
}

export async function isIssueWaitingForPullRequestCi(
  db: Db,
  params: IsIssueWaitingForPullRequestCiParams,
  prResolver?: PullRequestHeadResolver,
): Promise<boolean> {
  const [product] = await db
    .select({
      id: issueWorkProducts.id,
      status: issueWorkProducts.status,
      reviewState: issueWorkProducts.reviewState,
      healthStatus: issueWorkProducts.healthStatus,
      metadata: issueWorkProducts.metadata,
      url: issueWorkProducts.url,
    })
    .from(issueWorkProducts)
    .where(
      and(
        eq(issueWorkProducts.companyId, params.companyId),
        eq(issueWorkProducts.issueId, params.issueId),
        eq(issueWorkProducts.type, "pull_request"),
        eq(issueWorkProducts.provider, "github"),
        inArray(issueWorkProducts.status, ["open", "ready_for_review"]),
      ),
    )
    .limit(1);

  if (!product) return false;

  if (product.status !== "open" && product.status !== "ready_for_review") {
    return false;
  }

  if (product.reviewState === "changes_requested" || product.status === "changes_requested") {
    return false;
  }

  const meta = (product.metadata ?? {}) as Record<string, unknown>;
  if (meta.draft === true) return false;

  if (
    meta.reviewDecision === "CHANGES_REQUESTED" ||
    meta.review_decision === "CHANGES_REQUESTED" ||
    meta.reviewState === "changes_requested"
  ) {
    return false;
  }

  if (
    meta.ci === "not_green" ||
    meta.ciState === "not_green" ||
    meta.ciStatus === "failure" ||
    product.healthStatus === "unhealthy"
  ) {
    return false;
  }

  if (prResolver) {
    const repository =
      typeof meta.repo === "string" && meta.repo.includes("/")
        ? meta.repo
        : typeof meta.owner === "string" && typeof meta.repo === "string"
        ? `${meta.owner}/${meta.repo}`
        : null;
    const number =
      typeof meta.number === "number" && Number.isSafeInteger(meta.number)
        ? meta.number
        : null;

    if (repository && number !== null) {
      try {
        const head = await prResolver.resolve({
          companyId: params.companyId,
          repository,
          number,
        });
        if (!head.open || head.draft) return false;
        if (head.reviewDecision === "CHANGES_REQUESTED") return false;
        if (head.ci === "not_green") return false;
        return head.ci === "pending" || head.ci === "green";
      } catch {
        // Fall back to stored product and metadata checks above
      }
    }
  }

  return true;
}
