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
import { issueWorkProducts, issues, issueComments, externalObjects, type Db } from "@myrmidon/db";
import { selectOpenPullRequestWorkProduct, OPEN_PULL_REQUEST_WORK_PRODUCT_STATUSES } from "./policy.js";
import { extractPullRequestIssueIdentifier } from "../task-pr-sync/linking.js";
import type { OpenPullRequestSummary } from "../review-routing/github.js";

export const REVIEW_APPROVAL_PENDING_MERGE_CODE = "review_approval_pending_merge";

/**
 * Live open-PR lane (myrmidon OPE-12879): when the stored facts never saw the
 * pull request (the six 12.11 LOST-PR closings — no work product, no external
 * object, no matching verdict comment), the caller may ask GitHub directly.
 * The lookup lists open PRs of one repository through the same resolver the
 * review-routing lane uses; a failure must never manufacture a blocker, so an
 * error or empty list simply reads as "no live answer".
 */
export type LiveOpenPullRequestLookup = (
  companyId: string,
  repository: string,
) => Promise<OpenPullRequestSummary[]>;

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

/** The open pull request that keeps the done gate closed for this issue, if any (stored facts first, then an optional live GitHub lookup). */
export async function findApprovalPendingMergePullRequest(
  db: Pick<Db, "select">,
  companyId: string,
  issueId: string,
  liveLookup?: LiveOpenPullRequestLookup,
): Promise<{ id: string; url: string | null } | null> {
  const rows = await db
    .select({
      id: issueWorkProducts.id,
      type: issueWorkProducts.type,
      status: issueWorkProducts.status,
      url: issueWorkProducts.url,
      title: issueWorkProducts.title,
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

  if (!issueRow || typeof issueRow.identifier !== "string" || !issueRow.identifier) return null;

  const key = issueRow.identifier;
  const targetBranch = `bot/${key}`;

  const companyPrRows = await db
    .select({
      id: issueWorkProducts.id,
      type: issueWorkProducts.type,
      status: issueWorkProducts.status,
      url: issueWorkProducts.url,
      title: issueWorkProducts.title,
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

  const externalPrRows = await db
    .select({
      id: externalObjects.id,
      externalId: externalObjects.externalId,
      url: externalObjects.sanitizedCanonicalUrl,
      data: externalObjects.data,
    })
    .from(externalObjects)
    .where(
      and(
        eq(externalObjects.companyId, companyId),
        eq(externalObjects.providerKey, "github"),
        eq(externalObjects.objectType, "pull_request"),
        eq(externalObjects.isTerminal, false),
      ),
    );

  const openPrs = (Array.isArray(companyPrRows) ? companyPrRows : []).filter(
    (p) => OPEN_PULL_REQUEST_WORK_PRODUCT_STATUSES.has(p.status),
  );

  const branchMatch = openPrs.find((p) => {
    const meta = (p.metadata && typeof p.metadata === "object" ? p.metadata : {}) as Record<string, unknown>;
    const branch = String(meta.branch ?? meta.headRefName ?? meta.headBranch ?? "");
    if (branch === targetBranch) return true;
    const title = String(p.title ?? meta.title ?? "");
    const identifiedKey = extractPullRequestIssueIdentifier({
      headRef: branch,
      title,
    });
    return identifiedKey === key;
  });

  if (branchMatch) {
    return { id: branchMatch.id, url: branchMatch.url ?? null };
  }

  const unlinkedOpenPr = externalPrRows.find((p) => {
    const data = p.data && typeof p.data === "object" && !Array.isArray(p.data)
      ? p.data as Record<string, unknown>
      : {};
    const branch = typeof data.headRef === "string" ? data.headRef : "";
    if (branch === targetBranch) return true;
    const identifiedKey = extractPullRequestIssueIdentifier({
      headRef: data.headRef,
      title: data.title,
    });
    return identifiedKey === key;
  });

  if (unlinkedOpenPr) {
    return { id: unlinkedOpenPr.id, url: unlinkedOpenPr.url ?? null };
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
      const externalMatch = externalPrRows.find((p) => {
        const data = p.data && typeof p.data === "object" && !Array.isArray(p.data)
          ? p.data as Record<string, unknown>
          : {};
        const num = Number(data.number ?? NaN);
        const url = typeof data.url === "string" ? data.url : p.url;
        return num === prNum || Boolean(url && (url.endsWith(`/${prNum}`) || url.includes(`/pull/${prNum}`)));
      });
      if (externalMatch) {
        return { id: externalMatch.id, url: externalMatch.url ?? null };
      }
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

  // Live GitHub lane (OPE-12879): the stored facts never recorded this pull
  // request — no work product, no external object, no matching verdict
  // comment. Ask the same resolver the review-routing lane uses for open PRs
  // of every repository the company has seen PRs of, and match by the task
  // branch `bot/<KEY>` or the identifier in the PR title. A lookup failure or
  // empty answer never invents a blocker: done stays allowed exactly as
  // before when GitHub says nothing.
  if (liveLookup) {
    const repositories = await listCompanyPullRequestRepositories(db, companyId);
    for (const repository of repositories) {
      let listed: OpenPullRequestSummary[] = [];
      try {
        listed = await liveLookup(companyId, repository);
      } catch {
        continue;
      }
      const liveMatch = listed.find((pr) => {
        if (pr.headRef === targetBranch) return true;
        return extractPullRequestIssueIdentifier({ headRef: pr.headRef, title: pr.title }) === key;
      });
      if (liveMatch) {
        return {
          id: `github-live:${repository}#${liveMatch.number}`,
          url: liveMatch.url ?? `https://github.com/${repository}/pull/${liveMatch.number}`,
        };
      }
    }
  }

  return null;
}

/** Repositories the company has seen pull requests of (same sources as the review-routing repo list). */
async function listCompanyPullRequestRepositories(
  db: Pick<Db, "select">,
  companyId: string,
): Promise<string[]> {
  const repositories = new Set<string>();
  const externalRows = await db
    .select({ data: externalObjects.data })
    .from(externalObjects)
    .where(and(
      eq(externalObjects.companyId, companyId),
      eq(externalObjects.providerKey, "github"),
      eq(externalObjects.objectType, "pull_request"),
    ));
  for (const row of externalRows) {
    const data = row.data && typeof row.data === "object" && !Array.isArray(row.data)
      ? row.data as Record<string, unknown>
      : {};
    const owner = typeof data.owner === "string" ? data.owner : "";
    const repo = typeof data.repo === "string" ? data.repo : "";
    if (owner && repo) repositories.add(`${owner}/${repo}`);
  }
  const productRows = await db
    .select({ metadata: issueWorkProducts.metadata })
    .from(issueWorkProducts)
    .where(and(eq(issueWorkProducts.companyId, companyId), eq(issueWorkProducts.type, "pull_request")));
  for (const row of productRows) {
    const meta = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? row.metadata as Record<string, unknown>
      : {};
    const repo = typeof meta.repo === "string" && meta.repo.includes("/") ? meta.repo : "";
    if (repo) {
      repositories.add(repo);
    } else {
      const owner = typeof meta.owner === "string" ? meta.owner : "";
      const repoPart = typeof meta.repo === "string" ? meta.repo : "";
      if (owner && repoPart) repositories.add(`${owner}/${repoPart}`);
    }
  }
  return [...repositories].sort();
}
