import { and, eq, sql } from "drizzle-orm";
import { issues, issueWorkProducts, type Db } from "@myrmidon/db";
import { conflict } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
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

function noAccess(product: GateProduct, url?: string | null): never {
  const link = url ?? product.url ?? "the linked pull request";
  const ref = extractGitHubPullRequestReferences([link])[0] ?? null;
  const repository = ref ? `${ref.owner}/${ref.repo}` : "неизвестный репозиторий";
  throw conflict(`Не удаётся прочитать PR ${link}: у доски нет доступа к репозиторию ${repository} (настройте GitHub App/PAT)`, {
    code: ISSUE_DONE_PULL_REQUEST_GATE,
    reason: "repository_access_unavailable",
    workProductId: product.id,
    pullRequestUrl: url ?? product.url,
    repository: ref ? repository : null,
    retryable: true,
  });
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
          const replacementState = replacementDetails.workProductState ?? "unknown";
          if (replacementState === "merged" || replacementState === "closed") {
            try {
              await db.update(issueWorkProducts).set({
                status: replacementState,
                metadata: { ...metadata, state: replacementState, draft: false },
              }).where(and(eq(issueWorkProducts.id, product.id), eq(issueWorkProducts.companyId, companyId)));
            } catch (err) {
              logger.warn(
                { errorKind: "issue_done_pr_state_persist_failed", errorName: err instanceof Error ? err.name : typeof err, workProductId: product.id },
                "could not persist replacement pull-request state during done validation",
              );
            }
          }
          return {
            product,
            state: replacementState === "merged" ? "merged" as const : "closed" as const,
            url: product.url,
          };
        }
      }
      const state = details.workProductState ?? "unknown";
      if (state === "merged" || state === "closed") {
        const metadata = product.metadata && typeof product.metadata === "object" && !Array.isArray(product.metadata)
          ? product.metadata as Record<string, unknown>
          : {};
        try {
          await db.update(issueWorkProducts).set({
            status: state,
            metadata: { ...metadata, state, draft: false },
          }).where(and(eq(issueWorkProducts.id, product.id), eq(issueWorkProducts.companyId, companyId)));
        } catch (err) {
          logger.warn(
            { errorKind: "issue_done_pr_state_persist_failed", errorName: err instanceof Error ? err.name : typeof err, workProductId: product.id },
            "could not persist pull-request state during done validation",
          );
        }
      }
      return {
        product,
        state,
        url: product.url,
        ...(details.access === "denied" ? { accessDenied: true as const } : {}),
      };
    } catch (err) {
      logger.warn(
        { errorKind: "issue_done_pr_lookup_failed", errorName: err instanceof Error ? err.name : typeof err, workProductId: product.id },
        "could not resolve pull-request state during done validation",
      );
      return { product, state: "unknown" as const, url: product.url };
    }
  }));
  const merged = states.some(({ state }) => state === "merged");
  const closed = states.filter(({ state }) => state === "closed");
  if (merged && closed.length > 0) {
    return states.filter(({ state }) => state !== "closed");
  }
  return states;
}

export async function assertIssueCanBeDone(db: Db, companyId: string, issueId: string) {
  assertIssueDonePullRequestsSettled(await inspectIssueDonePullRequests(db, companyId, issueId));
}

export function assertIssueDonePullRequestsSettled(states: Awaited<ReturnType<typeof inspectIssueDonePullRequests>>) {
  for (const entry of states) {
    if (entry.state === "superseded" || entry.state === "merged") continue;
    if ("accessDenied" in entry && entry.accessDenied && entry.state === "unknown") noAccess(entry.product, entry.url);
    block(entry.product, entry.url);
  }
}

export function assertStoredIssueDonePullRequestsSettled(products: GateProduct[]) {
  const pullRequests = products.filter((product) => product.type === "pull_request");
  for (const product of pullRequests) {
    if (product.status === "archived" || product.status === "merged") continue;
    block(product);
  }
}

/** A short serialized validation/write window prevents a PR being attached between check and close. */
export async function assertIssueDoneSnapshotUnchanged(
  tx: Db,
  companyId: string,
  issueId: string,
  snapshot: Awaited<ReturnType<typeof inspectIssueDonePullRequests>>,
  liveSnapshot?: Awaited<ReturnType<typeof inspectIssueDonePullRequests>>,
) {
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
  const validatedSnapshot = liveSnapshot ?? snapshot;
  if (current.length !== validatedSnapshot.length || current.some((item) => {
    const currentState = validatedSnapshot.find((candidate) => candidate.product.id === item.id);
    return !currentState || currentState.product.url !== item.url || JSON.stringify(currentState.product.metadata) !== JSON.stringify(item.metadata);
  })) {
    throw conflict("Pull request links changed during completion validation. Retry marking the task done.", {
      code: ISSUE_DONE_PULL_REQUEST_GATE,
      retryable: true,
    });
  }
  assertIssueDonePullRequestsSettled(validatedSnapshot);
}