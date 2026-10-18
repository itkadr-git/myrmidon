import { and, eq, sql } from "drizzle-orm";
import { issues, issueWorkProducts, type Db } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import {
  createPullRequestMergeDetailsResolver,
  extractGitHubPullRequestReferences,
} from "../../services/github-pull-request-merge.js";

export const ISSUE_DONE_PULL_REQUEST_GATE = "issue_done_pull_request_gate";

type GateProduct = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  url: string | null;
  metadata: unknown;
};

function reference(product: GateProduct) {
  const metadata = product.metadata && typeof product.metadata === "object" && !Array.isArray(product.metadata)
    ? product.metadata as Record<string, unknown>
    : {};
  const repo = typeof metadata.repo === "string" ? metadata.repo : null;
  const number = typeof metadata.number === "number" && Number.isSafeInteger(metadata.number) && metadata.number > 0
    ? metadata.number
    : null;
  return extractGitHubPullRequestReferences([
    product.url,
    repo && number ? `${repo}#${number}` : null,
  ])[0] ?? null;
}

function block(product: GateProduct, url?: string | null): never {
  const link = url ?? product.url ?? "the linked pull request";
  throw conflict(`Cannot mark this task done until ${link} is merged. If the PR was closed without merging, link a verified replacement and retry.`, {
    code: ISSUE_DONE_PULL_REQUEST_GATE,
    workProductId: product.id,
    pullRequestUrl: url ?? product.url,
    retryable: true,
  });
}

/** Resolve PR state without holding the issue row lock or a database transaction. */
export async function inspectIssueDonePullRequests(
  db: Db,
  companyId: string,
  issueId: string,
  resolve = createPullRequestMergeDetailsResolver(db),
) {
  const products = await db.select({
    id: issueWorkProducts.id,
    companyId: issueWorkProducts.companyId,
    type: issueWorkProducts.type,
    status: issueWorkProducts.status,
    url: issueWorkProducts.url,
    metadata: issueWorkProducts.metadata,
  }).from(issueWorkProducts).where(and(
    eq(issueWorkProducts.companyId, companyId),
    eq(issueWorkProducts.issueId, issueId),
    eq(issueWorkProducts.type, "pull_request"),
  ));
  const states = await Promise.all(products.map(async (product) => {
    if (product.status === "archived") return { product, state: "superseded" as const, url: product.url };
    const ref = reference(product);
    if (!ref) return { product, state: "unknown" as const, url: product.url };
    try {
      const details = await resolve(companyId, ref);
      if (details.workProductState === "closed") {
        const metadata = product.metadata && typeof product.metadata === "object" && !Array.isArray(product.metadata)
          ? product.metadata as Record<string, unknown>
          : {};
        const replacement = extractGitHubPullRequestReferences([metadata.replacementPullRequestUrl])[0];
        if (replacement) {
          const replacementDetails = await resolve(companyId, replacement);
          return {
            product,
            state: replacementDetails.workProductState === "merged" ? "merged" as const : "closed" as const,
            url: product.url,
          };
        }
      }
      return { product, state: details.workProductState ?? "unknown", url: product.url };
    } catch {
      return { product, state: "unknown" as const, url: product.url };
    }
  }));
  return states;
}

export async function assertIssueCanBeDone(db: Db, companyId: string, issueId: string) {
  assertIssueDonePullRequestsSettled(await inspectIssueDonePullRequests(db, companyId, issueId));
}

export function assertIssueDonePullRequestsSettled(states: Awaited<ReturnType<typeof inspectIssueDonePullRequests>>) {
  for (const entry of states) {
    if (entry.state === "superseded" || entry.state === "merged") continue;
    block(entry.product, entry.url);
  }
}

export function assertStoredIssueDonePullRequestsSettled(products: GateProduct[]) {
  for (const product of products) {
    if (product.status === "archived" || product.status === "merged") continue;
    block(product);
  }
}

/** A short serialized validation/write window prevents a PR being attached between check and close. */
export async function assertIssueDoneSnapshotUnchanged(tx: Db, companyId: string, issueId: string, snapshot: Awaited<ReturnType<typeof inspectIssueDonePullRequests>>) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`issue-done-gate:${issueId}`}, 0))`);
  const currentIssue = await tx.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
  if (!currentIssue || currentIssue.companyId !== companyId) {
    throw conflict("Issue changed during completion validation. Retry marking the task done.", {
      code: ISSUE_DONE_PULL_REQUEST_GATE,
      retryable: true,
    });
  }
  const current = await tx.select({
    id: issueWorkProducts.id,
    companyId: issueWorkProducts.companyId,
    type: issueWorkProducts.type,
    status: issueWorkProducts.status,
    url: issueWorkProducts.url,
    metadata: issueWorkProducts.metadata,
  }).from(issueWorkProducts).where(and(
    eq(issueWorkProducts.companyId, companyId),
    eq(issueWorkProducts.issueId, issueId),
    eq(issueWorkProducts.type, "pull_request"),
  ));
  if (current.length !== snapshot.length || current.some((item) => {
    const old = snapshot.find((candidate) => candidate.product.id === item.id)?.product;
    return !old || old.status !== item.status || old.url !== item.url || JSON.stringify(old.metadata) !== JSON.stringify(item.metadata);
  })) {
    throw conflict("Pull request work products changed during completion validation. Retry marking the task done.", {
      code: ISSUE_DONE_PULL_REQUEST_GATE,
      retryable: true,
    });
  }
  assertIssueDonePullRequestsSettled(snapshot);
}