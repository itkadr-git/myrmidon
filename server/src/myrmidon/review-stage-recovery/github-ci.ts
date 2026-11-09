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
//
// myrmidon(OPE-12397): the reads are cached per process (see the read cache
// below) and nothing is sent to GitHub while the shared rate-limit state says
// the budget is gone. The stranded-issue sweep asks for the CI of every review
// stage with an open PR on each heartbeat tick, which made "review-recovery"
// the largest user of the App's 5000/h budget.

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { issueWorkProducts, type Db } from "@myrmidon/db";
import { DEFAULT_GITHUB_TOKEN_SECRET_NAMES } from "../../services/git-credentials.js";
import { getGitHubRateLimitMetrics, isGitHubRateLimited, recordGitHubRequest } from "../../services/github-rate-limit.js";
import { ghFetch, gitHubApiBase } from "../../services/github-fetch.js";
import { repositoryHasHostedCi } from "../../services/github-hosted-ci.js";
import { defaultTokenProvider as resolveGitHubReadToken } from "../../services/github-external-object-provider.js";
import {
  extractGitHubPullRequestReferences,
  type GitHubPullRequestReference,
} from "../../services/github-pull-request-merge.js";
import {
  REVIEW_CI_FINAL_CHECK_NAME,
  pullRequestHeadCiStateFromAllChecks,
  pullRequestHeadCiStateFromChecks,
  pullRequestHeadFinalCheckConclusion,
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

/** The budget as the shared rate-limit state knows it (the same fields a 403 answer reports). */
function currentRateLimitFacts(): RateLimitFacts {
  const { remaining, limit, resetEpochSeconds } = getGitHubRateLimitMetrics();
  return { remaining, limit, resetEpochSeconds };
}

async function readJson(fetchImpl: FetchLike, url: string, token: string | null): Promise<JsonRead> {
  // myrmidon(OPE-12397): the shared budget is gone, so no request is sent; the answer is the one a
  // 403 rate limit gives, with the time to come back, and the recovery waits for it.
  if (isGitHubRateLimited()) {
    return { ok: false, code: "skipped_rate_limited", status: null, rateLimit: currentRateLimitFacts() };
  }
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: headers(token), signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    recordGitHubRequest("review-recovery", response);
  } catch {
    return { ok: false, code: "network_error", status: null };
  }
  if (!response.ok) {
    const rateLimited = response.status === 429 ||
      (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.statusText?.toLowerCase().includes("rate limit")));
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

// myrmidon(OPE-12397): read cache of the CI reads, one per process.
//
// The stranded-issue sweep asks for the CI of the open PR of every review stage on each
// heartbeat tick (30 s), and each ask was 2-4 GETs that nothing remembered: ~2400 requests an
// hour from "review-recovery" alone, against the App's budget of 5000. Three reads are kept:
//   pull    the head of an open PR (repository#number)       for MYRMIDON_REVIEW_CI_PULL_CACHE_TTL_SEC (60 s)
//   ci      the CI verdict of a head commit (repository@sha)  for the same TTL, but for
//           MYRMIDON_REVIEW_CI_COMPLETE_CACHE_TTL_SEC (600 s) once the CI of the head is complete
//   failed  the failed checks of a head commit               with the same two TTLs
// 0 for both turns the cache off (the stop while the rate limit is exhausted stays). An error is
// never stored, a result read with one token is never served to a caller with another (the key
// holds a hash of the token), reads of one key that run at the same time share one request, and
// at most REVIEW_CI_CACHE_MAX_ENTRIES entries are kept, the oldest leave first. While the shared
// rate-limit state says the budget is gone an entry is served even after it expired: the
// alternative is "unknown" for every review stage.
const PULL_CACHE_TTL_ENV = "MYRMIDON_REVIEW_CI_PULL_CACHE_TTL_SEC";
const COMPLETE_CACHE_TTL_ENV = "MYRMIDON_REVIEW_CI_COMPLETE_CACHE_TTL_SEC";
const DEFAULT_PULL_CACHE_TTL_SECONDS = 60;
const DEFAULT_COMPLETE_CACHE_TTL_SECONDS = 600;
export const REVIEW_CI_CACHE_MAX_ENTRIES = 5000;

/** A TTL from the environment in ms: 0 turns it off, anything but a non-negative integer is the default. */
function ttlMsFromEnv(name: string, fallbackSeconds: number): number {
  const raw = process.env[name]?.trim();
  return (raw && /^\d+$/.test(raw) ? Number(raw) : fallbackSeconds) * 1000;
}

/** How long a PR head is remembered, and a verdict that is not final yet. */
function pullTtlMs(): number {
  return ttlMsFromEnv(PULL_CACHE_TTL_ENV, DEFAULT_PULL_CACHE_TTL_SECONDS);
}

/** How long a verdict is remembered once the CI of the head is complete. */
function completeTtlMs(): number {
  return ttlMsFromEnv(COMPLETE_CACHE_TTL_ENV, DEFAULT_COMPLETE_CACHE_TTL_SECONDS);
}

type ReadFailure = { ok: false; reason: string; rateLimit?: RateLimitFacts | null };
type CachedRead<T> = { ok: true; value: T } | ReadFailure;
/** What a loader hands back: the value and how long to remember it (0 = not at all). */
type LoadedRead<T> = { ok: true; value: T; ttlMs: number } | ReadFailure;

const readCache = new Map<string, { value: unknown; expiresAt: number }>();
const readsInFlight = new Map<string, Promise<unknown>>();
/** Bumped by the test reset: a read that started before it must not be stored. */
let readCacheEpoch = 0;

export function resetReviewCiCacheForTests(): void {
  readCacheEpoch += 1;
  readCache.clear();
  readsInFlight.clear();
}

/** What the token may see, without the token itself: the hash never leaves the cache key. */
function tokenScope(token: string | null): string {
  return token ? createHash("sha256").update(token).digest("hex").slice(0, 16) : "anonymous";
}

function repositoryKey(reference: GitHubPullRequestReference): string {
  return `${reference.host}/${reference.owner}/${reference.repo}`.toLowerCase();
}

function rememberRead(key: string, value: unknown, ttlMs: number): void {
  readCache.delete(key);
  while (readCache.size >= REVIEW_CI_CACHE_MAX_ENTRIES) {
    const oldest = readCache.keys().next().value;
    if (oldest === undefined) break;
    readCache.delete(oldest);
  }
  readCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function cachedRead<T>(key: string, load: () => Promise<LoadedRead<T>>): Promise<CachedRead<T>> {
  if (pullTtlMs() === 0 && completeTtlMs() === 0) return load();
  const entry = readCache.get(key);
  if (entry && (entry.expiresAt > Date.now() || isGitHubRateLimited())) {
    return Promise.resolve<CachedRead<T>>({ ok: true, value: entry.value as T });
  }
  const running = readsInFlight.get(key);
  if (running) return running as Promise<CachedRead<T>>;
  const epoch = readCacheEpoch;
  const read: Promise<CachedRead<T>> = load()
    .then((loaded) => {
      if (loaded.ok && loaded.ttlMs > 0 && epoch === readCacheEpoch) rememberRead(key, loaded.value, loaded.ttlMs);
      return loaded;
    })
    .finally(() => {
      if (readsInFlight.get(key) === read) readsInFlight.delete(key);
    });
  readsInFlight.set(key, read);
  return read;
}

type PullHead = { open: boolean; headSha: string | null };

type HeadCiOutcome = {
  state: "pending" | "complete" | "unknown" | "not_configured";
  /** Only for "unknown": a short code of what was read, never a token. */
  reason?: string;
  /**
   * myrmidon(OPE-12176): the conclusion of the finished final `CI result` check
   * ("green"/"red" verdict of the head), when the state is "complete". Cached
   * with the state: it belongs to the same head read.
   */
  finalCheckConclusion?: string | null;
};

/** A verdict that is read without an error: remembered long once the CI of the head is complete. */
function settledHeadCi(outcome: HeadCiOutcome): LoadedRead<HeadCiOutcome> {
  return { ok: true, value: outcome, ttlMs: outcome.state === "complete" ? completeTtlMs() : pullTtlMs() };
}

/** The CI verdict of one head commit from GitHub; no cache here. */
async function readHeadCi(input: {
  fetchImpl: FetchLike;
  reference: GitHubPullRequestReference;
  token: string | null;
  headSha: string;
  apiBase: string;
  repository: string;
}): Promise<LoadedRead<HeadCiOutcome>> {
  const { fetchImpl, headSha, apiBase, repository } = input;
  // The hosted-CI probe does not go through readJson, so the stop is repeated before it.
  if (isGitHubRateLimited()) {
    return {
      ok: false,
      reason: `check_runs:skipped_rate_limited${input.token ? "" : " (anonymous)"}`,
      rateLimit: currentRateLimitFacts(),
    };
  }
  const hostedCi = await repositoryHasHostedCi({ ...input.reference, token: input.token, fetch: fetchImpl });
  if (hostedCi === false) return settledHeadCi({ state: "not_configured" });
  // Only the final check is asked for; `filter=all` keeps the check runs of earlier workflow
  // runs of the same head too, which the policy then discards when they were cancelled/skipped.
  const checkRunsUrl =
    `${apiBase}/repos/${repository}/commits/${encodeURIComponent(headSha)}/check-runs` +
    `?check_name=${encodeURIComponent(REVIEW_CI_FINAL_CHECK_NAME)}&filter=all&per_page=100`;
  const checkRuns = await readGitHub(fetchImpl, checkRunsUrl, input.token, "check_runs");
  if (!checkRuns.ok) return checkRuns;
  const runs = asRecord(checkRuns.json)?.check_runs;
  if (!Array.isArray(runs)) return { ok: false, reason: "check_runs:unreadable_payload" };
  const stateFromFinalCheck = pullRequestHeadCiStateFromChecks({ checkRuns: runs });
  if (stateFromFinalCheck === "complete") {
    return settledHeadCi({ state: "complete", finalCheckConclusion: pullRequestHeadFinalCheckConclusion({ checkRuns: runs }) });
  }
  // myrmidon(OPE-12048): a repository without the aggregate `CI result` check
  // (any third-party workflow, e.g. plain build/test lanes) never completes the
  // filtered read above, so its verdict gate waited forever. When the head has
  // no run of that name at all, read the latest run of every check and decide
  // from the whole head. A run named `CI result` that exists but is queued or
  // in progress keeps the aggregate-check semantics: pending.
  const hasFinalCheckRun = runs.some((entry) => asRecord(entry)?.name === REVIEW_CI_FINAL_CHECK_NAME);
  if (hasFinalCheckRun) return settledHeadCi({ state: stateFromFinalCheck });
  const allRunsUrl =
    `${apiBase}/repos/${repository}/commits/${encodeURIComponent(headSha)}/check-runs` +
    `?filter=latest&per_page=100`;
  const allRuns = await readGitHub(fetchImpl, allRunsUrl, input.token, "check_runs");
  if (!allRuns.ok) return allRuns;
  const allRunsPayload = asRecord(allRuns.json);
  const allRunsList = allRunsPayload?.check_runs;
  if (!Array.isArray(allRunsList)) return { ok: false, reason: "check_runs:unreadable_payload" };
  // A partial list could hide a queued check: decide only from a complete page.
  const totalCount = typeof allRunsPayload?.total_count === "number" ? allRunsPayload.total_count : allRunsList.length;
  if (totalCount > allRunsList.length) {
    return settledHeadCi({ state: "unknown", reason: "check_runs:more_than_one_page" });
  }
  // The aggregate run exists after all (queued or in progress, e.g. between the
  // lanes finishing and the aggregate starting): the aggregate decides, pending.
  const hasAggregateRun = allRunsList.some(
    (entry) => asRecord(entry)?.name === REVIEW_CI_FINAL_CHECK_NAME,
  );
  if (hasAggregateRun) return settledHeadCi({ state: stateFromFinalCheck });
  return settledHeadCi({ state: pullRequestHeadCiStateFromAllChecks({ checkRuns: allRunsList }) });
}

/** CI state of the current head of one pull request; network only, injected fetch for tests. */
export async function resolvePullRequestHeadCi(input: {
  reference: GitHubPullRequestReference;
  /** Null reads anonymously: the repository may be public. */
  token: string | null;
  fetch?: FetchLike;
}): Promise<{
  state: "pending" | "complete" | "unknown" | "not_configured" | "no_pull_request";
  headSha: string | null;
  /** Only for "unknown": a short code of what failed, never a token. */
  reason?: string;
  /**
   * myrmidon(OPE-12176): the conclusion of the finished final `CI result` check
   * when the state is "complete" (null when the finished run carries no
   * conclusion), so the caller can tell green from red without another read.
   */
  finalCheckConclusion?: string | null;
  /** GitHub budget headers for a failed read, for operator diagnostics and reset scheduling. */
  rateLimit?: RateLimitFacts | null;
}> {
  const fetchImpl = input.fetch ?? ghFetch;
  const apiBase = gitHubApiBase(input.reference.host);
  const repository = `${encodeURIComponent(input.reference.owner)}/${encodeURIComponent(input.reference.repo)}`;
  const keyBase = `${tokenScope(input.token)}|${repositoryKey(input.reference)}`;
  const pull = await cachedRead<PullHead>(`pull|${keyBase}#${input.reference.number}`, async (): Promise<LoadedRead<PullHead>> => {
    const read = await readGitHub(fetchImpl, `${apiBase}/repos/${repository}/pulls/${input.reference.number}`, input.token, "pull");
    if (!read.ok) return read;
    const pullRecord = asRecord(read.json);
    if (!pullRecord) return { ok: false, reason: "pull:unreadable_payload" };
    const headRecord = asRecord(pullRecord.head);
    return {
      ok: true,
      value: { open: pullRecord.state === "open", headSha: typeof headRecord?.sha === "string" ? headRecord.sha : null },
      ttlMs: pullTtlMs(),
    };
  });
  if (!pull.ok) {
    return {
      state: "unknown",
      headSha: null,
      reason: pull.reason,
      ...(pull.rateLimit ? { rateLimit: pull.rateLimit } : {}),
    };
  }
  const { open, headSha } = pull.value;
  // A merged or closed pull request has no CI to wait for; the PR sync owns it.
  if (!open) return { state: "no_pull_request", headSha };
  if (!headSha) return { state: "unknown", headSha: null, reason: "pull:no_head_sha" };
  const ci = await cachedRead<HeadCiOutcome>(`ci|${keyBase}@${headSha}`, () =>
    readHeadCi({ fetchImpl, reference: input.reference, token: input.token, headSha, apiBase, repository }),
  );
  if (!ci.ok) {
    return {
      state: "unknown",
      headSha,
      reason: ci.reason,
      ...(ci.rateLimit ? { rateLimit: ci.rateLimit } : {}),
    };
  }
  return {
    state: ci.value.state,
    headSha,
    // myrmidon(OPE-12176): the verdict travels with the state so review
    // admission can tell green from red without a second GitHub read. A
    // completed check without a conclusion carries no verdict: the key stays
    // away instead of shadowing the state with a null.
    ...(typeof ci.value.finalCheckConclusion === "string"
      ? { finalCheckConclusion: ci.value.finalCheckConclusion }
      : {}),
    ...(ci.value.reason ? { reason: ci.value.reason } : {}),
  };
}

/** The pull request work product of an issue and its GitHub reference, as far as the board can read them. */
type IssuePullRequestTarget =
  | { kind: "none" }
  | { kind: "unreadable"; pullRequestUrl: string | null }
  | { kind: "ok"; pullRequestUrl: string | null; reference: GitHubPullRequestReference };

async function loadIssuePullRequestTarget(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<IssuePullRequestTarget> {
  const products = await db
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
  if (!product) return { kind: "none" };
  const metadata = asRecord(product.metadata) ?? {};
  const repo = typeof metadata.repo === "string" ? metadata.repo
    : typeof metadata.repository === "string" ? metadata.repository
    : null;
  const number = typeof metadata.number === "number" ? metadata.number : null;
  const metadataUrl = typeof metadata.url === "string" && metadata.url.trim() !== "" ? metadata.url : null;
  // OPE-12024: a stored empty string is as good as NULL for readability; the
  // effective url prefers the column and falls back to metadata.url.
  const effectiveUrl = (product.url !== null && product.url !== "") ? product.url : metadataUrl;
  const reference = extractGitHubPullRequestReferences([effectiveUrl, repo && number ? `${repo}#${number}` : null])[0] ?? null;
  if (!reference) return { kind: "unreadable", pullRequestUrl: effectiveUrl };
  return { kind: "ok", pullRequestUrl: effectiveUrl, reference };
}

/**
 * myrmidon(OPE-12177): the head SHA of the issue's open pull request as the
 * stored work-product metadata holds it (kept fresh by the PR sync sweep and
 * the GitHub webhook). No GitHub read and no token; the review-admission
 * dedup key uses it so the same head dedups and a moved head wakes again.
 */
export async function readReviewPullRequestHeadSha(input: {
  db: Db;
  companyId: string;
  issueId: string;
}): Promise<string | null> {
  try {
    const products = await input.db
      .select({
        id: issueWorkProducts.id,
        type: issueWorkProducts.type,
        status: issueWorkProducts.status,
        isPrimary: issueWorkProducts.isPrimary,
        updatedAt: issueWorkProducts.updatedAt,
        metadata: issueWorkProducts.metadata,
      })
      .from(issueWorkProducts)
      .where(
        and(
          eq(issueWorkProducts.companyId, input.companyId),
          eq(issueWorkProducts.issueId, input.issueId),
          eq(issueWorkProducts.type, "pull_request"),
        ),
      );
    const product = selectOpenPullRequestWorkProduct(products);
    const metadata = asRecord(product?.metadata);
    const headSha = metadata?.headSha;
    return typeof headSha === "string" && headSha.trim() !== "" ? headSha.trim() : null;
  } catch {
    // An unreadable store must not fail the wake path: the key falls back to
    // the legacy agent-keyed format.
    return null;
  }
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
    const target = await loadIssuePullRequestTarget(input.db, companyId, issueId);
    if (target.kind === "none") return { state: "no_pull_request", pullRequestUrl: null, headSha: null };
    if (target.kind === "unreadable") {
      return { state: "unknown", pullRequestUrl: target.pullRequestUrl, headSha: null, reason: "pull_request_reference_unreadable" };
    }
    const { reference, pullRequestUrl } = target;
    let token: string | null = null;
    let tokenError = false;
    try {
      token = (await tokenProvider(companyId, `${reference.owner}/${reference.repo}`))?.trim() || null;
    } catch {
      tokenError = true;
    }
    try {
      const head = await resolvePullRequestHeadCi({ reference, token, fetch: input.fetch });
      if (head.state !== "unknown") {
        // myrmidon(OPE-12176): the verdict of the final check travels with the
        // state; review admission tells green from red without a second read.
        return {
          state: head.state,
          pullRequestUrl,
          headSha: head.headSha,
          ...(typeof head.finalCheckConclusion === "string" ? { finalCheckConclusion: head.finalCheckConclusion } : {}),
        };
      }
      return {
        state: "unknown",
        pullRequestUrl,
        headSha: head.headSha,
        reason: `${head.reason ?? "read_failed"}${tokenError ? "; token provider failed" : ""}`,
        ...(head.rateLimit ? { rateLimit: head.rateLimit } : {}),
      };
    } catch {
      return { state: "unknown", pullRequestUrl, headSha: null, reason: "read_failed" };
    }
  };
}

/** Conclusions of a finished check run that mean the check itself failed (cancelled and skipped runs are not failures). */
const FAILED_CHECK_CONCLUSIONS: ReadonlySet<string> = new Set(["failure", "timed_out", "startup_failure", "action_required"]);

export type ReviewHeadFailedChecks =
  /** `failed` are the names of the checks that finished with a failing conclusion on the head (latest run per check). */
  | { state: "ok"; headSha: string; pullRequestUrl: string | null; failed: string[] }
  /** The board could not read the check runs; the caller keeps its normal behaviour. */
  | { state: "unknown"; reason: string };

export type ReviewHeadFailedChecksResolver = (input: {
  companyId: string;
  issueId: string;
  /** The head the review decision was made on; a pull request whose head moved since is "unknown". */
  headSha: string;
}) => Promise<ReviewHeadFailedChecks>;

type HeadFailedChecks = { state: "ok"; failed: string[] } | { state: "unknown"; reason: string };

/**
 * Names of the checks that failed on one head commit. Network only, injected
 * fetch for tests. `filter=latest` keeps the newest run of every check name, so
 * a check that failed and was re-run green is not listed. A list that does not
 * fit one page is "unknown": a partial list could hide a code failure.
 * myrmidon(OPE-12397): remembered like the CI verdict of the head; the list is
 * final for the long TTL once every check of the head has finished.
 */
export async function resolvePullRequestHeadFailedChecks(input: {
  reference: GitHubPullRequestReference;
  token: string | null;
  headSha: string;
  fetch?: FetchLike;
}): Promise<HeadFailedChecks> {
  const fetchImpl = input.fetch ?? ghFetch;
  const apiBase = gitHubApiBase(input.reference.host);
  const repository = `${encodeURIComponent(input.reference.owner)}/${encodeURIComponent(input.reference.repo)}`;
  const url =
    `${apiBase}/repos/${repository}/commits/${encodeURIComponent(input.headSha)}/check-runs` +
    `?filter=latest&per_page=100`;
  const key = `failed|${tokenScope(input.token)}|${repositoryKey(input.reference)}@${input.headSha}`;
  const checks = await cachedRead<HeadFailedChecks>(key, async (): Promise<LoadedRead<HeadFailedChecks>> => {
    const read = await readGitHub(fetchImpl, url, input.token, "check_runs");
    if (!read.ok) return read;
    const body = asRecord(read.json);
    const runs = body?.check_runs;
    if (!body || !Array.isArray(runs)) return { ok: false, reason: "check_runs:unreadable_payload" };
    const totalCount = body.total_count;
    const total = typeof totalCount === "number" ? totalCount : runs.length;
    if (total > runs.length) {
      return { ok: true, value: { state: "unknown", reason: "check_runs:more_than_one_page" }, ttlMs: pullTtlMs() };
    }
    const failed: string[] = [];
    let finished = runs.length > 0;
    for (const entry of runs) {
      const run = asRecord(entry);
      if (!run || typeof run.name !== "string") continue;
      if (run.status !== "completed") {
        finished = false;
        continue;
      }
      if (typeof run.conclusion === "string" && FAILED_CHECK_CONCLUSIONS.has(run.conclusion) && !failed.includes(run.name)) {
        failed.push(run.name);
      }
    }
    return { ok: true, value: { state: "ok", failed }, ttlMs: finished ? completeTtlMs() : pullTtlMs() };
  });
  if (!checks.ok) return { state: "unknown", reason: checks.reason };
  // A copy: the caller may keep or change the list, the cached one stays as it was read.
  return checks.value.state === "ok" ? { state: "ok", failed: [...checks.value.failed] } : checks.value;
}

export function createReviewHeadFailedChecksResolver(input: {
  db: Db;
  fetch?: FetchLike;
  tokenProvider?: (companyId: string, repository: string) => Promise<string | null>;
}): ReviewHeadFailedChecksResolver {
  const tokenProvider =
    input.tokenProvider ??
    ((companyId: string, repository: string) =>
      resolveGitHubReadToken(input.db, companyId, repository, DEFAULT_GITHUB_TOKEN_SECRET_NAMES, input.fetch));

  return async ({ companyId, issueId, headSha }) => {
    const target = await loadIssuePullRequestTarget(input.db, companyId, issueId);
    if (target.kind !== "ok") return { state: "unknown", reason: target.kind === "none" ? "no_pull_request" : "pull_request_reference_unreadable" };
    let token: string | null = null;
    try {
      token = (await tokenProvider(companyId, `${target.reference.owner}/${target.reference.repo}`))?.trim() || null;
    } catch {
      // Anonymous read: the repository may be public; a failed read answers "unknown" below.
    }
    try {
      const failed = await resolvePullRequestHeadFailedChecks({ reference: target.reference, token, headSha, fetch: input.fetch });
      if (failed.state === "unknown") return failed;
      return { state: "ok", headSha, pullRequestUrl: target.pullRequestUrl, failed: failed.failed };
    } catch {
      return { state: "unknown", reason: "read_failed" };
    }
  };
}
