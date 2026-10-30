// myrmidon(OPE-10045): reads the CI state of the head of an issue's open pull
// request, so a reviewer that waits for CI is not treated as a stalled review.
//
// The token path is the one the review-routing lane uses (the company secrets
// named in DEFAULT_GITHUB_TOKEN_SECRET_NAMES). Any trouble — no token, GitHub
// error, unreadable payload — answers "unknown": the board never turns a read
// failure into a wait.

import { and, eq } from "drizzle-orm";
import { issueWorkProducts, type Db } from "@myrmidon/db";
import { DEFAULT_GITHUB_TOKEN_SECRET_NAMES } from "../../services/git-credentials.js";
import { ghFetch, gitHubApiBase } from "../../services/github-fetch.js";
import {
  extractGitHubPullRequestReferences,
  type GitHubPullRequestReference,
} from "../../services/github-pull-request-merge.js";
import {
  pullRequestHeadCiStateFromChecks,
  selectOpenPullRequestWorkProduct,
  type ReviewPullRequestCiFacts,
} from "./policy.js";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type ReviewPullRequestCiResolver = (input: {
  companyId: string;
  issueId: string;
}) => Promise<ReviewPullRequestCiFacts>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function headers(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "myrmidon-review-stage-recovery",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
  };
}

async function fetchJson(fetchImpl: FetchLike, url: string, token: string): Promise<unknown> {
  const response = await fetchImpl(url, { headers: headers(token) }).catch(() => null);
  if (!response || !response.ok) return null;
  return response.json().catch(() => null);
}

/** CI state of the current head of one pull request; network only, injected fetch for tests. */
export async function resolvePullRequestHeadCi(input: {
  reference: GitHubPullRequestReference;
  token: string;
  fetch?: FetchLike;
}): Promise<{ state: "pending" | "complete" | "unknown" | "no_pull_request"; headSha: string | null }> {
  const fetchImpl = input.fetch ?? ghFetch;
  const apiBase = gitHubApiBase(input.reference.host);
  const repository = `${encodeURIComponent(input.reference.owner)}/${encodeURIComponent(input.reference.repo)}`;
  const pull = asRecord(await fetchJson(fetchImpl, `${apiBase}/repos/${repository}/pulls/${input.reference.number}`, input.token));
  if (!pull) return { state: "unknown", headSha: null };
  const headSha = typeof asRecord(pull.head)?.sha === "string" ? (asRecord(pull.head)!.sha as string) : null;
  // A merged or closed pull request has no CI to wait for; the PR sync owns it.
  if (pull.state !== "open") return { state: "no_pull_request", headSha };
  if (!headSha) return { state: "unknown", headSha: null };
  const sha = encodeURIComponent(headSha);
  const [checkRunsPayload, combinedStatusPayload] = await Promise.all([
    fetchJson(fetchImpl, `${apiBase}/repos/${repository}/commits/${sha}/check-runs?per_page=100`, input.token),
    fetchJson(fetchImpl, `${apiBase}/repos/${repository}/commits/${sha}/status`, input.token),
  ]);
  const checkRuns = asRecord(checkRunsPayload)?.check_runs;
  return {
    state: pullRequestHeadCiStateFromChecks({
      checkRuns: Array.isArray(checkRuns) ? checkRuns : null,
      combinedStatus: asRecord(combinedStatusPayload),
    }),
    headSha,
  };
}

export function createReviewPullRequestCiResolver(input: {
  db: Db;
  fetch?: FetchLike;
  tokenProvider?: (companyId: string) => Promise<string | null>;
}): ReviewPullRequestCiResolver {
  const tokenProvider =
    input.tokenProvider ??
    (async (companyId: string) => {
      // Loaded lazily: the recovery service sits in the heartbeat import graph.
      const { secretService } = await import("../../services/secrets.js");
      const secrets = secretService(input.db);
      for (const secretName of DEFAULT_GITHUB_TOKEN_SECRET_NAMES) {
        const secret = await secrets.getByName(companyId, secretName);
        if (!secret) continue;
        const token = await secrets.resolveSecretValue(companyId, secret.id, "latest");
        const trimmed = token?.trim();
        if (trimmed) return trimmed;
      }
      return null;
    });

  return async ({ companyId, issueId }) => {
    const products = await input.db
      .select({
        id: issueWorkProducts.id,
        type: issueWorkProducts.type,
        status: issueWorkProducts.status,
        url: issueWorkProducts.url,
        metadata: issueWorkProducts.metadata,
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
    const product = selectOpenPullRequestWorkProduct(products);
    if (!product) return { state: "no_pull_request", pullRequestUrl: null, headSha: null };
    const metadata = asRecord(product.metadata) ?? {};
    const repo = typeof metadata.repo === "string" ? metadata.repo : null;
    const number = typeof metadata.number === "number" ? metadata.number : null;
    const reference = extractGitHubPullRequestReferences([product.url, repo && number ? `${repo}#${number}` : null])[0] ?? null;
    if (!reference) return { state: "unknown", pullRequestUrl: product.url, headSha: null };
    let token: string | null = null;
    try {
      token = (await tokenProvider(companyId))?.trim() || null;
    } catch {
      token = null;
    }
    if (!token) return { state: "unknown", pullRequestUrl: product.url, headSha: null };
    try {
      const head = await resolvePullRequestHeadCi({ reference, token, fetch: input.fetch });
      return { state: head.state, pullRequestUrl: product.url, headSha: head.headSha };
    } catch {
      return { state: "unknown", pullRequestUrl: product.url, headSha: null };
    }
  };
}
