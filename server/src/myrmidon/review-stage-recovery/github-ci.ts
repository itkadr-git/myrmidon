// myrmidon(OPE-10045, OPE-10063): reads the CI state of the head of an issue's
// open pull request, so a reviewer that waits for CI is not treated as a
// stalled review.
//
// CI of the head is finished only when its final `CI result` check exists and
// is completed (policy.ts). Everything else on the head is ignored.
//
// The token path is the one the task-pr-sync PR reads use
// (github-external-object-provider.ts): a company secret named in
// DEFAULT_GITHUB_TOKEN_SECRET_NAMES, otherwise a read-only installation token
// of the shared GitHub App identity, otherwise no token. The review-routing
// lane reads the company secrets only. On the release board no secret has one
// of those names, so the App path (or an anonymous read of the public
// repository) is what makes this read work at all. Any trouble — network,
// GitHub error, unreadable payload — answers "unknown" with a short reason
// (never a token); the recovery then waits for CI the same bounded way as for
// a running CI and logs the reason.

import { and, eq } from "drizzle-orm";
import { issueWorkProducts, type Db } from "@myrmidon/db";
import { DEFAULT_GITHUB_TOKEN_SECRET_NAMES } from "../../services/git-credentials.js";
import { ghFetch, gitHubApiBase } from "../../services/github-fetch.js";
import { defaultTokenProvider as resolveGitHubReadToken } from "../../services/github-external-object-provider.js";
import {
  extractGitHubPullRequestReferences,
  type GitHubPullRequestReference,
} from "../../services/github-pull-request-merge.js";
import {
  REVIEW_CI_FINAL_CHECK_NAME,
  pullRequestHeadCiStateFromChecks,
  selectOpenPullRequestWorkProduct,
  type ReviewPullRequestCiFacts,
} from "./policy.js";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type ReviewPullRequestCiResolver = (input: {
  companyId: string;
  issueId: string;
}) => Promise<ReviewPullRequestCiFacts>;

/** One GitHub read must not hold the recovery pass: the vendor ghFetch has no timeout of its own. */
const READ_TIMEOUT_MS = 15_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function headers(token: string | null): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "myrmidon-review-stage-recovery",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

type JsonRead =
  | { ok: true; json: unknown }
  | { ok: false; code: string; status: number | null; rateLimit?: RateLimitFacts | null };

/** The measured budget of one GitHub answer (x-ratelimit-* headers; no token, OPE-10246). */
type RateLimitFacts = {
  remaining: number | null;
  limit: number | null;
  resetEpochSeconds: number | null;
};

function rateLimitFactsOf(response: Response): RateLimitFacts | null {
  const read = (name: string): number | null => {
    const raw = response.headers.get(`x-ratelimit-${name}`);
    if (raw === null || raw.trim() === "") return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const facts: RateLimitFacts = {
    remaining: read("remaining"),
    limit: read("limit"),
    resetEpochSeconds: read("reset"),
  };
  return facts.remaining !== null || facts.limit !== null || facts.resetEpochSeconds !== null ? facts : null;
}

async function readJson(fetchImpl: FetchLike, url: string, token: string | null): Promise<JsonRead> {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: headers(token), signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
  } catch {
    return { ok: false, code: "network_error", status: null };
  }
  if (!response.ok) {
    const rateLimited = response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0";
    return {
      ok: false,
      code: `http_${response.status}${rateLimited ? "_rate_limited" : ""}`,
      status: response.status,
      rateLimit: rateLimitFactsOf(response),
    };
  }
  try {
    return { ok: true, json: await response.json() };
  } catch {
    return { ok: false, code: "unreadable_payload", status: response.status };
  }
}

/**
 * One GitHub read. A token GitHub refuses for this resource (an App token
 * without the checks permission, a revoked one) must not hide data that is
 * public, so a 401/403/404 is retried once without the token.
 */
async function readGitHub(
  fetchImpl: FetchLike,
  url: string,
  token: string | null,
  what: string,
): Promise<{ ok: true; json: unknown } | { ok: false; reason: string; rateLimit?: RateLimitFacts | null }> {
  const first = await readJson(fetchImpl, url, token);
  if (first.ok) return first;
  if (token && (first.status === 401 || first.status === 403 || first.status === 404)) {
    // An exhausted authenticated installation budget applies to the installation,
    // not just this endpoint. Anonymous fallback burns the shared IP quota too;
    // preserve the reset time so the monitor can retry after GitHub's reset.
    if (first.code.endsWith("_rate_limited")) {
      return { ok: false, reason: `${what}:${first.code}`, rateLimit: first.rateLimit };
    }
    const anonymous = await readJson(fetchImpl, url, null);
    if (anonymous.ok) return anonymous;
    return {
      ok: false,
      reason: `${what}:${first.code}+anonymous:${anonymous.code}`,
      rateLimit: anonymous.rateLimit ?? first.rateLimit,
    };
  }
  return { ok: false, reason: `${what}:${first.code}${token ? "" : " (anonymous)"}`, rateLimit: first.rateLimit };
}

/** CI state of the current head of one pull request; network only, injected fetch for tests. */
export async function resolvePullRequestHeadCi(input: {
  reference: GitHubPullRequestReference;
  /** Null reads anonymously: the repository may be public. */
  token: string | null;
  fetch?: FetchLike;
}): Promise<{
  state: "pending" | "complete" | "unknown" | "no_pull_request";
  headSha: string | null;
  /** Only for "unknown": a short code of what failed, never a token. */
  reason?: string;
  /** GitHub budget headers for a failed read, for operator diagnostics and reset scheduling. */
  rateLimit?: RateLimitFacts | null;
}> {
  const fetchImpl = input.fetch ?? ghFetch;
  const apiBase = gitHubApiBase(input.reference.host);
  const repository = `${encodeURIComponent(input.reference.owner)}/${encodeURIComponent(input.reference.repo)}`;
  const pull = await readGitHub(fetchImpl, `${apiBase}/repos/${repository}/pulls/${input.reference.number}`, input.token, "pull");
  if (!pull.ok) {
    return {
      state: "unknown",
      headSha: null,
      reason: pull.reason,
      ...(pull.rateLimit ? { rateLimit: pull.rateLimit } : {}),
    };
  }
  const pullRecord = asRecord(pull.json);
  if (!pullRecord) return { state: "unknown", headSha: null, reason: "pull:unreadable_payload" };
  const headRecord = asRecord(pullRecord.head);
  const headSha = typeof headRecord?.sha === "string" ? headRecord.sha : null;
  // A merged or closed pull request has no CI to wait for; the PR sync owns it.
  if (pullRecord.state !== "open") return { state: "no_pull_request", headSha };
  if (!headSha) return { state: "unknown", headSha: null, reason: "pull:no_head_sha" };
  // Only the final check is asked for; `filter=all` keeps the check runs of earlier workflow
  // runs of the same head too, which the policy then discards when they were cancelled/skipped.
  const checkRunsUrl =
    `${apiBase}/repos/${repository}/commits/${encodeURIComponent(headSha)}/check-runs` +
    `?check_name=${encodeURIComponent(REVIEW_CI_FINAL_CHECK_NAME)}&filter=all&per_page=100`;
  const checkRuns = await readGitHub(fetchImpl, checkRunsUrl, input.token, "check_runs");
  if (!checkRuns.ok) {
    return {
      state: "unknown",
      headSha,
      reason: checkRuns.reason,
      ...(checkRuns.rateLimit ? { rateLimit: checkRuns.rateLimit } : {}),
    };
  }
  const runs = asRecord(checkRuns.json)?.check_runs;
  if (!Array.isArray(runs)) return { state: "unknown", headSha, reason: "check_runs:unreadable_payload" };
  return { state: pullRequestHeadCiStateFromChecks({ checkRuns: runs }), headSha };
}

export function createReviewPullRequestCiResolver(input: {
  db: Db;
  fetch?: FetchLike;
  tokenProvider?: (companyId: string, repository: string) => Promise<string | null>;
}): ReviewPullRequestCiResolver {
  const tokenProvider =
    input.tokenProvider ??
    ((companyId: string, repository: string) =>
      resolveGitHubReadToken(input.db, companyId, repository, DEFAULT_GITHUB_TOKEN_SECRET_NAMES, input.fetch));

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
    if (!reference) {
      return { state: "unknown", pullRequestUrl: product.url, headSha: null, reason: "pull_request_reference_unreadable" };
    }
    let token: string | null = null;
    let tokenError = false;
    try {
      token = (await tokenProvider(companyId, `${reference.owner}/${reference.repo}`))?.trim() || null;
    } catch {
      tokenError = true;
    }
    try {
      const head = await resolvePullRequestHeadCi({ reference, token, fetch: input.fetch });
      if (head.state !== "unknown") return { state: head.state, pullRequestUrl: product.url, headSha: head.headSha };
      return {
        state: "unknown",
        pullRequestUrl: product.url,
        headSha: head.headSha,
        reason: `${head.reason ?? "read_failed"}${tokenError ? "; token provider failed" : ""}`,
        ...(head.rateLimit ? { rateLimit: head.rateLimit } : {}),
      };
    } catch {
      return { state: "unknown", pullRequestUrl: product.url, headSha: null, reason: "read_failed" };
    }
  };
}
