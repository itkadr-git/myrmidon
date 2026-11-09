// myrmidon(MYR-WS-RECOVER): the pull request that belongs to a run's task, for the
// hermes gateway's `workspace` field (packages/adapters/hermes buildWorkspaceField).
//
// The bot's copy of a task must be the repository and the branch of the task's PR, not
// whatever the task's project is bound to: OPE-7967 (PR #82 of itkadr-git/myrmidon-deploy
// under a project of itkadr-git/myrmidon) failed every run with "already open for ...".
// The source is the task's own `pull_request` work product (metadata.repo / metadata.headRef,
// else the repository named by its URL); a merged or closed one is no longer a place to work.

import type { Db } from "@myrmidon/db";
import type { IssueWorkProduct } from "@myrmidon/shared";
import { extractGitHubPullRequestReferences } from "../services/github-pull-request-merge.js";
import { workProductService } from "../services/work-products.js";

export interface RunPullRequest {
  repo: string;
  number?: number;
  /** Head branch of the PR; absent when the work product does not carry it. */
  headRef?: string;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF_RE = /^[^\s~^:?*[\]\\]+$/;
const FINISHED = new Set(["merged", "closed", "abandoned", "cancelled", "canceled"]);

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validRef(value: string): boolean {
  const ref = value.replace(/^refs\/heads\//, "");
  return ref.length > 0 && ref.length <= 200 && REF_RE.test(ref) && !ref.startsWith("-") && !ref.includes("..");
}

/** The first usable open pull request among the task's work products (primary first, as listed). */
export function selectRunPullRequest(
  products: ReadonlyArray<Pick<IssueWorkProduct, "type" | "provider" | "url" | "status" | "metadata">>,
): RunPullRequest | null {
  for (const product of products) {
    if (product.type !== "pull_request") continue;
    const metadata = (product.metadata ?? {}) as Record<string, unknown>;
    if (FINISHED.has(str(product.status).toLowerCase()) || FINISHED.has(str(metadata.state).toLowerCase())) continue;
    const reference = extractGitHubPullRequestReferences([product.url])[0];
    const metaRepo = str(metadata.repo);
    const repo = REPO_RE.test(metaRepo) ? metaRepo : reference ? `${reference.owner}/${reference.repo}` : "";
    if (!repo || !REPO_RE.test(repo)) continue;
    const number = typeof metadata.number === "number" && Number.isSafeInteger(metadata.number) ? metadata.number : reference?.number;
    const headRef = str(metadata.headRef);
    return {
      repo,
      ...(number ? { number } : {}),
      ...(headRef && validRef(headRef) ? { headRef: headRef.replace(/^refs\/heads\//, "") } : {}),
    };
  }
  return null;
}

/**
 * Reads the task's PR for a run. Best effort: the live lookup of the head branch gets a few
 * seconds, then the stored work product is used; any failure leaves the field unset (the
 * adapter then falls back to the project).
 */
export async function loadRunPullRequest(db: Db, issueId: string, timeoutMs = 5000): Promise<RunPullRequest | null> {
  const service = workProductService(db);
  let products: IssueWorkProduct[];
  try {
    products = await Promise.race([
      service.listForIssue(issueId, { refreshPullRequests: true }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("pull request lookup timed out")), timeoutMs).unref()),
    ]);
  } catch {
    try {
      products = await service.listForIssue(issueId);
    } catch {
      return null;
    }
  }
  return selectRunPullRequest(products);
}
