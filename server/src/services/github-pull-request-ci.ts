import type { Db } from "@myrmidon/db";
import { and, eq, isNull } from "drizzle-orm";
import { issueWorkProducts, issues, issueComments } from "@myrmidon/db";
import { DEFAULT_GITHUB_TOKEN_SECRET_NAMES } from "./git-credentials.js";
import { repositoryHasHostedCi, NO_HOSTED_CI_SUMMARY } from "./github-hosted-ci.js";
import type { FetchLike } from "./github-external-object-provider.js";
import { resetGitHubObjectCacheForTests, resolveGitHubRepositoryToken } from "./github-external-object-provider.js";
import type { GitHubPullRequestReference } from "./github-pull-request-merge.js";
import {
  createPullRequestMergeDetailsResolver,
  extractGitHubPullRequestReferences,
} from "./github-pull-request-merge.js";
import {
  recordGitHubRequest,
  isGitHubRateLimited,
  getGitHubRateLimitResetTime,
  formatUtcTime,
  resetGitHubRateLimitForTests,
} from "./github-rate-limit.js";
import type { GitHubRequestSource } from "./github-rate-limit.js";

export interface PullRequestCiJob {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion:
    | "success"
    | "failure"
    | "neutral"
    | "cancelled"
    | "timed_out"
    | "action_required"
    | "skipped"
    | null;
  url: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface PullRequestFailedJob {
  id: number;
  name: string;
  conclusion: string;
  url: string;
  completedAt: string | null;
}

export type PullRequestCiStatus =
  | "completed"
  | "in_progress"
  | "queued"
  | "pending"
  | "no_checks"
  | "not_configured"
  | "unavailable"
  | "unknown";

export type PullRequestCiConclusion =
  | "success"
  | "failure"
  | "pending"
  | "neutral"
  | "cancelled"
  | "timed_out"
  | "action_required"
  | "skipped"
  | "no_checks"
  | "not_configured"
  | "missing"
  | "denied"
  | "rate_limited"
  | "incomplete"
  | "unavailable"
  | "unknown";

export interface PullRequestCiResult {
  repository: string;
  pullNumber: number;
  headSha: string | null;
  headRef: string | null;
  status: PullRequestCiStatus;
  conclusion: PullRequestCiConclusion;
  summary: string;
  authoritative: boolean;
  checkedAt: string;
  completedAt: string | null;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  failedJobs: PullRequestFailedJob[];
  optionalFailedJobs?: PullRequestFailedJob[];
  /**
   * myrmidon(CI-SNAPSHOT-CANCELLED): required checks whose latest record on
   * this head is `cancelled` with no later replacement. Not a test failure.
   */
  cancelledJobs?: PullRequestFailedJob[];
  runs: PullRequestCiJob[];
}

export const DEFAULT_REQUIRED_CHECKS: readonly string[] = ["CI result", "hot files review"];

export interface SummarizeCheckRunsOptions {
  headSha?: string | null;
  repository?: string;
  pullNumber?: number;
  requiredChecks?: readonly string[];
}

export const runTimeKey = (run: PullRequestCiJob): number => {
  const raw = run.startedAt ?? run.completedAt;
  const t = raw ? new Date(raw).getTime() : Number.NaN;
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
};

export const compareRuns = (x: PullRequestCiJob, y: PullRequestCiJob): number => {
  const a = runTimeKey(x);
  const b = runTimeKey(y);
  if (a !== b) return a > b ? 1 : -1;
  return x.id - y.id;
};

export const latestOf = (list: readonly PullRequestCiJob[]): PullRequestCiJob | null =>
  list.reduce<PullRequestCiJob | null>((best, r) => (!best || compareRuns(r, best) > 0 ? r : best), null);

export const workflowRunIdOf = (run: PullRequestCiJob): string | null =>
  /\/actions\/runs\/(\d+)/.exec(run.url ?? "")?.[1] ?? null;

// myrmidon(CI-SNAPSHOT-CANCELLED): per check name (trimmed, case-insensitive)
// exactly one record represents the check on this head - the last COMPLETED
// record that carries a verdict (success / failure / timed_out /
// action_required ...). Earlier records of the same name (cancelled by a
// replaced run, failed before a re-run) are superseded. Rules:
//  - a later `skipped` / `neutral` never displaces an earlier verdict (a
//    skipped gate job of a cancelled re-run must not hide a real failure);
//  - a later `cancelled` never displaces an earlier verdict either: the
//    failure of the last finished run stays visible;
//  - a record still queued / in progress that is newer than the last verdict
//    is the re-run in flight and represents the check (pending);
//  - with no verdict at all, the newest of the `cancelled` / `skipped` /
//    `neutral` records is taken; `skipped` replaces an older `cancelled` only
//    when it belongs to another (known) workflow run, otherwise the cancel
//    stays (a skipped gate of a cancelled run is not a replacement).
// Order is one deterministic key: time (`startedAt`, else `completedAt`; a
// record without time, e.g. queued, is the newest), then `id`.
export const pickRepresentativeRun = (group: readonly PullRequestCiJob[]): PullRequestCiJob => {
  const inflight = latestOf(group.filter((r) => r.status !== "completed"));
  const completed = group.filter((r) => r.status === "completed");
  const verdict = latestOf(
    completed.filter((r) => r.conclusion !== "cancelled" && r.conclusion !== "skipped" && r.conclusion !== "neutral"),
  );
  if (inflight && (!verdict || compareRuns(inflight, verdict) > 0)) return inflight;
  if (verdict) return verdict;
  const cancelled = latestOf(completed.filter((r) => r.conclusion === "cancelled"));
  const quiet = latestOf(completed.filter((r) => r.conclusion !== "cancelled"));
  if (cancelled && quiet) {
    const cancelledRun = workflowRunIdOf(cancelled);
    const quietRun = workflowRunIdOf(quiet);
    const quietIsReplacement =
      cancelledRun !== null && quietRun !== null && cancelledRun !== quietRun && compareRuns(quiet, cancelled) > 0;
    return quietIsReplacement ? quiet : cancelled;
  }
  return (cancelled ?? quiet ?? inflight) as PullRequestCiJob;
};

export const pickRepresentative = pickRepresentativeRun;

export function selectRepresentativeRuns(
  runs: readonly PullRequestCiJob[],
): PullRequestCiJob[] {
  const groupsByName = new Map<string, PullRequestCiJob[]>();
  for (const run of runs) {
    const key = run.name.trim().toLowerCase();
    const group = groupsByName.get(key);
    if (group) group.push(run);
    else groupsByName.set(key, [run]);
  }
  const representatives = new Set<PullRequestCiJob>();
  for (const group of groupsByName.values()) representatives.add(pickRepresentativeRun(group));
  return runs.filter((r) => representatives.has(r));
}

export function summarizeCheckRuns(
  runs: readonly PullRequestCiJob[],
  options?: SummarizeCheckRunsOptions,
): {
  status: PullRequestCiStatus;
  conclusion: PullRequestCiConclusion;
  summary: string;
  authoritative: boolean;
  completedAt: string | null;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  failedJobs: PullRequestFailedJob[];
  optionalFailedJobs?: PullRequestFailedJob[];
  cancelledJobs?: PullRequestFailedJob[];
} {
  const meta = runs as unknown as {
    authoritative?: boolean;
    status?: PullRequestCiStatus;
    conclusion?: PullRequestCiConclusion;
    summary?: string;
    incomplete?: boolean;
  };

  if (
    meta?.conclusion === "missing" ||
    meta?.conclusion === "denied" ||
    meta?.conclusion === "unavailable" ||
    meta?.conclusion === "incomplete" ||
    meta?.conclusion === "rate_limited"
  ) {
    return {
      status: meta.status ?? "unavailable",
      conclusion: meta.conclusion,
      summary: meta.summary ?? `checks ${meta.conclusion}`,
      authoritative: false,
      completedAt: null,
      totalRuns: runs.length,
      successfulRuns: 0,
      failedRuns: 0,
      failedJobs: [],
      optionalFailedJobs: [],
    };
  }

  if (runs.length === 0) {
    return {
      status: meta?.status ?? "pending",
      conclusion: meta?.conclusion ?? "no_checks",
      summary: meta?.summary ?? "no checks reported",
      authoritative: false,
      completedAt: null,
      totalRuns: 0,
      successfulRuns: 0,
      failedRuns: 0,
      failedJobs: [],
      optionalFailedJobs: [],
    };
  }

  // myrmidon(CI-SNAPSHOT-CANCELLED): per check name (trimmed, case-insensitive)
  // exactly one record represents the check on this head - the last COMPLETED
  // record that carries a verdict (success / failure / timed_out /
  // action_required ...). Earlier records of the same name (cancelled by a
  // replaced run, failed before a re-run) are superseded.
  const effectiveRuns = selectRepresentativeRuns(runs);
  const totalRuns = effectiveRuns.length;

  const configuredRequired =
    options?.requiredChecks ??
    (process.env.CI_REQUIRED_CHECKS
      ? process.env.CI_REQUIRED_CHECKS.split(",").map((s) => s.trim()).filter(Boolean)
      : process.env.PULL_REQUEST_CI_REQUIRED_CHECKS
        ? process.env.PULL_REQUEST_CI_REQUIRED_CHECKS.split(",").map((s) => s.trim()).filter(Boolean)
        : DEFAULT_REQUIRED_CHECKS);

  const requiredNamesSet = new Set(configuredRequired.map((s) => s.trim().toLowerCase()));

  const isKnownOptional = (name: string) => {
    const lower = name.trim().toLowerCase();
    return lower === "main-green" || lower.startsWith("main-green");
  };

  const hasConfiguredRequiredInRuns = effectiveRuns.some((r) =>
    requiredNamesSet.has(r.name.trim().toLowerCase()),
  );

  const isCheckRequired = (run: PullRequestCiJob): boolean => {
    if (isKnownOptional(run.name)) {
      return false;
    }
    if (options?.requiredChecks !== undefined || hasConfiguredRequiredInRuns) {
      return requiredNamesSet.has(run.name.trim().toLowerCase());
    }
    return true;
  };

  const failedJobs: PullRequestFailedJob[] = [];
  const optionalFailedJobs: PullRequestFailedJob[] = [];
  const cancelledJobs: PullRequestFailedJob[] = [];
  const cancelledRunIds = new Map<PullRequestFailedJob, string | null>();
  const ciResultSuccessRunIds = new Set<string>();
  let successfulRuns = 0;
  let successfulRequiredRuns = 0;
  let inProgressCount = 0;
  let inProgressRequiredCount = 0;
  let latestCompletedAt: string | null = null;

  for (const run of effectiveRuns) {
    if (run.completedAt) {
      if (!latestCompletedAt || new Date(run.completedAt).getTime() > new Date(latestCompletedAt).getTime()) {
        latestCompletedAt = run.completedAt;
      }
    }

    const required = isCheckRequired(run);

    if (run.status !== "completed") {
      inProgressCount++;
      if (required) {
        inProgressRequiredCount++;
      }
      continue;
    }

    const conclusion = run.conclusion;
    if (conclusion === "success" || conclusion === "skipped" || conclusion === "neutral") {
      successfulRuns++;
      if (required) {
        successfulRequiredRuns++;
      }
      if (run.name.trim().toLowerCase() === "ci result" && conclusion === "success") {
        const runId = workflowRunIdOf(run);
        if (runId) ciResultSuccessRunIds.add(runId);
      }
    } else if (conclusion === "cancelled") {
      // The latest record of this check is cancelled and nothing replaced it:
      // not a test failure, only a check that did not finish.
      if (required) {
        const job: PullRequestFailedJob = {
          id: run.id,
          name: run.name,
          conclusion: "cancelled",
          url: run.url,
          completedAt: run.completedAt,
        };
        cancelledJobs.push(job);
        cancelledRunIds.set(job, workflowRunIdOf(run));
      }
    } else {
      const failedJob: PullRequestFailedJob = {
        id: run.id,
        name: run.name,
        conclusion: conclusion ?? (conclusion === null ? "unknown" : "failure"),
        url: run.url,
        completedAt: run.completedAt,
      };
      if (required) {
        failedJobs.push(failedJob);
      } else {
        optionalFailedJobs.push(failedJob);
      }
    }
  }

  // A successful `CI result` absorbs only the cancelled required checks of its
  // own workflow run (same run id). A cancelled check outside it - or one whose
  // run cannot be told from the check data - keeps the summary `cancelled`.
  const absorbedCancelledJobs = cancelledJobs.filter((job) => {
    const runId = cancelledRunIds.get(job);
    return runId !== null && runId !== undefined && ciResultSuccessRunIds.has(runId);
  });
  for (const job of absorbedCancelledJobs) cancelledJobs.splice(cancelledJobs.indexOf(job), 1);
  const failedRuns = failedJobs.length;
  const cancelledNote = cancelledJobs.length > 0 ? `, ${cancelledJobs.length} cancelled` : "";
  let status: PullRequestCiStatus;
  let conclusion: PullRequestCiConclusion;
  let summary: string;

  if (failedRuns > 0) {
    conclusion = "failure";
    status = inProgressRequiredCount > 0 ? "in_progress" : "completed";
    summary = `failure (${failedRuns} failed, ${successfulRequiredRuns} passed${inProgressRequiredCount > 0 ? `, ${inProgressRequiredCount} running` : ""}${cancelledNote})`;
  } else if (inProgressRequiredCount > 0) {
    status = "in_progress";
    conclusion = "pending";
    summary = `in progress (${inProgressRequiredCount} running, ${successfulRequiredRuns} passed${cancelledNote})`;
  } else if (cancelledJobs.length > 0) {
    status = "completed";
    conclusion = "cancelled";
    summary = `cancelled, not a test failure (${cancelledJobs.length} cancelled, ${successfulRequiredRuns} passed): ${cancelledJobs.map((j) => j.name).join(", ")}; checks were cancelled and not replaced by a newer run - rerun CI`;
  } else {
    status = "completed";
    conclusion = "success";
    const ignored = absorbedCancelledJobs.length > 0 ? `, ${absorbedCancelledJobs.length} cancelled of the same run as a successful CI result ignored` : "";
    if (optionalFailedJobs.length > 0) {
      summary = `success (${successfulRuns}/${totalRuns} passed, ${optionalFailedJobs.length} optional failed (не влияет)${ignored})`;
    } else {
      summary = `success (${successfulRuns}/${totalRuns} passed${ignored})`;
    }
  }

  return {
    status,
    conclusion,
    summary,
    authoritative: meta?.authoritative ?? true,
    completedAt: latestCompletedAt,
    totalRuns,
    successfulRuns,
    failedRuns,
    failedJobs,
    optionalFailedJobs,
    cancelledJobs,
  };
}

export type CheckRunsFetchResult = PullRequestCiJob[] & {
  authoritative: boolean;
  status?: PullRequestCiStatus;
  conclusion?: PullRequestCiConclusion;
  summary?: string;
  incomplete?: boolean;
  rateLimitResetAt?: number;
  etag?: string;
};

function getResponseHeader(response: Response, name: string): string | null {
  return response.headers?.get(name) ?? null;
}

export async function fetchCommitCheckRuns(
  owner: string,
  repo: string,
  headSha: string,
  token: string | null,
  fetchImpl: FetchLike = fetch,
  options: { maxPages?: number; etag?: string; cachedRuns?: CommitCheckRunsCacheEntry } = {},
): Promise<CheckRunsFetchResult> {
  const maxPages = options.maxPages ?? 10;
  const cachedRuns = options.cachedRuns;
  const allRuns: PullRequestCiJob[] = [];
  let page = 1;
  let totalCount: number | null = null;
  let fetchFailed = false;
  let failStatus: number | null = null;
  let rateLimitResetAt: number | undefined;
  let rateLimited = false;
  let tokenPermissionDenied = false;
  let rateLimitCachedRuns: CommitCheckRunsCacheEntry | undefined;

  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "myrmidon-ci-resolver",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  if (options.etag) {
    headers["if-none-match"] = options.etag;
  }

  while (page <= maxPages) {
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(headSha)}/check-runs?per_page=100&page=${page}&filter=latest`;
    let res: Response;
    try {
      res = await fetchImpl(url, { headers });
      recordGitHubRequest("ci-resolver", res);
    } catch {
      fetchFailed = true;
      break;
    }

    if (res.status === 304) {
      const result = (allRuns.length > 0 ? allRuns : []) as CheckRunsFetchResult;
      result.authoritative = false;
      result.status = "unavailable";
      result.conclusion = "incomplete";
      result.summary = "checks unchanged (not modified)";
      result.etag = getResponseHeader(res, "etag") ?? options.etag;
      return result;
    }

    if (!res.ok) {
      failStatus = res.status;
      let errorMessage: string | undefined;
      const bodyResponse = typeof res.clone === "function" ? res.clone() : res;
      if (typeof bodyResponse.json === "function") {
        const body = await bodyResponse.json().catch(() => null) as { message?: unknown } | null;
        if (typeof body?.message === "string") errorMessage = body.message;
      }
      tokenPermissionDenied = Boolean(token)
        && res.status === 403
        && errorMessage === "Resource not accessible by personal access token";

      const remaining = getResponseHeader(res, "x-ratelimit-remaining");
      const retryText = typeof res.clone === "function"
        ? (await res.clone().text().catch(() => "")).toLowerCase()
        : typeof res.text === "function"
          ? (await res.text().catch(() => "")).toLowerCase()
          : "";
      rateLimited = res.status === 429 ||
        (res.status === 403 && (remaining === "0" || retryText.includes("rate limit") || errorMessage?.toLowerCase().includes("rate limit") === true));
      if (rateLimited) {
        const reset = Number(getResponseHeader(res, "x-ratelimit-reset"));
        if (Number.isFinite(reset) && reset > 0) rateLimitResetAt = reset * 1000;
        rateLimitCachedRuns = cachedRuns;
      }
      fetchFailed = true;
      break;
    }

    const responseEtag = getResponseHeader(res, "etag");
    const data = (await res.json().catch(() => null)) as {
      total_count?: number;
      check_runs?: Array<{
        id: number;
        name: string;
        status: string;
        conclusion: string | null;
        html_url: string;
        started_at: string | null;
        completed_at: string | null;
      }>;
    } | null;

    if (!data || !Array.isArray(data.check_runs)) {
      fetchFailed = true;
      break;
    }

    if (typeof data.total_count === "number") {
      totalCount = data.total_count;
    }

    for (const cr of data.check_runs) {
      allRuns.push({
        id: cr.id,
        name: cr.name,
        status: (cr.status === "completed" || cr.status === "in_progress" || cr.status === "queued"
          ? cr.status
          : "in_progress") as "queued" | "in_progress" | "completed",
        conclusion: cr.conclusion as PullRequestCiJob["conclusion"],
        url: cr.html_url,
        startedAt: cr.started_at ?? null,
        completedAt: cr.completed_at ?? null,
      });
    }

    if (data.check_runs.length < 100 || (totalCount !== null && allRuns.length >= totalCount)) {
      (allRuns as CheckRunsFetchResult).etag = responseEtag ?? undefined;
      break;
    }

    page++;
  }

  const result = allRuns as CheckRunsFetchResult;

  if (fetchFailed && allRuns.length === 0) {
    result.authoritative = false;
    if (rateLimited && rateLimitCachedRuns) {
      const staleRuns = rateLimitCachedRuns.runs;
      result.push(...staleRuns);
      result.authoritative = false;
      result.status = staleRuns.status;
      result.conclusion = "rate_limited";
      result.rateLimitResetAt = rateLimitResetAt;
      result.etag = rateLimitCachedRuns.etag ?? undefined;
      const until = rateLimitResetAt
        ? formatUtcTime(new Date(rateLimitResetAt))
        : getGitHubRateLimitResetTime() ?? "unknown";
      result.summary = `${staleRuns.summary ?? "checks unavailable"} (устарел; GitHub rate limit until ${until})`;
    } else if (rateLimited) {
      result.authoritative = false;
      result.status = "unavailable";
      result.conclusion = "rate_limited";
      result.rateLimitResetAt = rateLimitResetAt;
      const until = rateLimitResetAt
        ? formatUtcTime(new Date(rateLimitResetAt))
        : getGitHubRateLimitResetTime() ?? "unknown";
      result.summary = `checks unavailable (GitHub rate limit until ${until})`;
    } else if (failStatus === 404) {
      result.status = "unavailable";
      result.conclusion = "missing";
      result.summary = "checks missing (commit or check-runs not found)";
    } else if (failStatus === 403 || failStatus === 401) {
      result.status = "unavailable";
      result.conclusion = "denied";
      result.summary = tokenPermissionDenied
        ? "checks unavailable (token lacks checks/actions read)"
        : "checks unavailable (access denied)";
    } else if (failStatus === 422) {
      result.status = "unavailable";
      result.conclusion = "unavailable";
      result.summary = "checks unavailable (unprocessable commit SHA)";
    } else {
      result.status = "unavailable";
      result.conclusion = "unavailable";
      result.summary = `checks unavailable (HTTP ${failStatus ?? "network_error"})`;
    }
  } else if (fetchFailed || (totalCount !== null && allRuns.length < totalCount)) {
    result.authoritative = false;
    result.incomplete = true;
    result.status = "in_progress";
    result.conclusion = "incomplete";
    result.summary = `incomplete checks (${allRuns.length}/${totalCount ?? "unknown"} runs retrieved)`;
  } else if (allRuns.length === 0) {
    result.authoritative = false;
    result.status = "pending";
    result.conclusion = "no_checks";
    result.summary = "no checks reported";
  } else {
    result.authoritative = true;
  }

  return result;
}

export interface PullRequestCiResolverOptions {
  fetch?: FetchLike;
  tokenProvider?: (companyId: string, repository: string) => Promise<string | null> | string | null;
  secretNames?: readonly string[];
  prResolver?: (
    companyId: string,
    reference: GitHubPullRequestReference,
  ) => Promise<{
    headSha: string | null;
    headRef: string | null;
    access?: "denied";
    state?: string;
  }>;
}

export interface PullRequestCiResolver {
  resolveForPullRequest(
    companyId: string,
    reference: GitHubPullRequestReference | { host?: "github.com"; owner: string; repo: string; number: number },
  ): Promise<PullRequestCiResult>;
  resolveForIssue(companyId: string, issueId: string): Promise<PullRequestCiResult[]>;
}

const CI_CACHE_MAX_ENTRIES = 500;
export const CI_CACHE_COMPLETED_TTL_MS = 30 * 60 * 1000; // 30m for completed CI
export const CI_CACHE_INCOMPLETE_TTL_MS = 60 * 1000; // 60s for incomplete CI
export const PR_HEAD_CACHE_TTL_MS = 60 * 1000; // 60s for PR head

// myrmidon(OPE-12397): `resolveForIssue` runs on every wake payload build; a
// task (or its comment history) naming dozens of PRs must not multiply into
// dozens of GitHub reads per run start. The task's own live PR work products
// are the primary signal; anything beyond the cap is dropped, oldest link last.
export const CI_RESOLVE_FOR_ISSUE_MAX_REFS = 10;

/** PR work products whose state can no longer change (their reads never return). */
export const TERMINAL_PULL_REQUEST_PRODUCT_STATUSES = new Set([
  "merged",
  "closed",
  "abandoned",
  "cancelled",
  "canceled",
]);

interface CacheEntry {
  expiresAt: number;
  result: PullRequestCiResult;
}

const ciCache = new Map<string, CacheEntry>();

interface PrHeadCacheEntry {
  headSha: string | null;
  headRef: string | null;
  etag?: string | null;
  expiresAt: number;
}
const prHeadCache = new Map<string, PrHeadCacheEntry>();

interface CommitCheckRunsCacheEntry {
  etag?: string | null;
  runs: CheckRunsFetchResult;
  expiresAt: number;
}
const checkRunsCache = new Map<string, CommitCheckRunsCacheEntry>();

export function clearCiCacheForTests(): void {
  ciCache.clear();
  prHeadCache.clear();
  checkRunsCache.clear();
  resetGitHubRateLimitForTests();
  resetGitHubObjectCacheForTests();
}

export const GITHUB_REQUEST_TIMEOUT_MS = 8_000;

export async function withCiResolveDeadline<T>(
  promise: Promise<T>,
  fallback: T,
  timeoutMs = 12_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createPullRequestCiResolver(
  db: Db,
  options: PullRequestCiResolverOptions & { source?: GitHubRequestSource } = {},
): PullRequestCiResolver {
  // myrmidon(OPE-12397): `run-context` for run-start / wake-payload builds
  // (heartbeat), `ui-refresh` for UI-triggered calls (routes); the historical
  // default keeps the pre-OPE-12397 label for callers without a bucket.
  const { source = "run-context", ...resolverOptions } = options;
  const rawFetch = resolverOptions.fetch ?? fetch;
  const fetchImpl: FetchLike = (input, init) => {
    const timeoutSignal = AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    return rawFetch(input, { ...init, signal });
  };
  const secretNames = options.secretNames ?? DEFAULT_GITHUB_TOKEN_SECRET_NAMES;
  const tokenProvider =
    options.tokenProvider ??
    ((companyId: string, repository: string) =>
      resolveGitHubRepositoryToken(db, companyId, repository, secretNames, fetchImpl));
  const prResolver =
    options.prResolver ??
    createPullRequestMergeDetailsResolver(db, {
      fetch: fetchImpl,
      tokenProvider,
      secretNames,
      source,
    });

  return {
    async resolveForPullRequest(
      companyId: string,
      referenceInput: GitHubPullRequestReference | { host?: "github.com"; owner: string; repo: string; number: number },
    ): Promise<PullRequestCiResult> {
      const reference: GitHubPullRequestReference = {
        host: referenceInput.host ?? "github.com",
        owner: referenceInput.owner,
        repo: referenceInput.repo,
        number: referenceInput.number,
      };
      const repoKey = `${reference.owner}/${reference.repo}`;
      const prKey = `${reference.owner.toLowerCase()}/${reference.repo.toLowerCase()}#${reference.number}`;

      let cachedHead = prHeadCache.get(prKey);
      let headSha = cachedHead && cachedHead.expiresAt > Date.now() ? cachedHead.headSha : null;
      let headRef = cachedHead && cachedHead.expiresAt > Date.now() ? cachedHead.headRef : null;

      if (!headSha && isGitHubRateLimited()) {
        for (const [, entry] of ciCache.entries()) {
          if (entry.result.repository.toLowerCase() === repoKey.toLowerCase() && entry.result.pullNumber === reference.number) {
            return {
              ...entry.result,
              authoritative: false,
              summary: `${entry.result.summary} (устарел; GitHub rate limit until ${getGitHubRateLimitResetTime() ?? "unknown"})`,
            };
          }
        }
        return {
          repository: repoKey,
          pullNumber: reference.number,
          headSha: null,
          headRef: null,
          status: "unavailable",
          conclusion: "rate_limited",
          summary: `checks unavailable (GitHub rate limit until ${getGitHubRateLimitResetTime() ?? "unknown"})`,
          authoritative: false,
          checkedAt: new Date().toISOString(),
          completedAt: null,
          totalRuns: 0,
          successfulRuns: 0,
          failedRuns: 0,
          failedJobs: [],
          runs: [],
        };
      }

      if (!headSha) {
        let prDetails: { headSha: string | null; headRef: string | null; access?: "denied"; state?: string } = {
          headSha: null,
          headRef: null,
        };
        try {
          prDetails = await prResolver(companyId, reference);
        } catch {
          // Fallback or unavailable if prResolver throws
        }
        headSha = prDetails.headSha;
        headRef = prDetails.headRef;

        if ((prDetails as { access?: string }).access === "denied") {
          return {
            repository: repoKey,
            pullNumber: reference.number,
            headSha: null,
            headRef: null,
            status: "unavailable",
            conclusion: "denied",
            summary: "checks unavailable (access denied)",
            authoritative: false,
            checkedAt: new Date().toISOString(),
            completedAt: null,
            totalRuns: 0,
            successfulRuns: 0,
            failedRuns: 0,
            failedJobs: [],
            runs: [],
          };
        }

        if (headSha) {
          prHeadCache.set(prKey, {
            headSha,
            headRef,
            etag: null,
            expiresAt: Date.now() + PR_HEAD_CACHE_TTL_MS,
          });
        }
      }

      if (!headSha) {
        try {
          const token = await tokenProvider(companyId, repoKey);
          const headers: Record<string, string> = {
            Accept: "application/vnd.github+json",
            "User-Agent": "Myrmidon-CI-Resolver",
          };
          if (token) {
            headers.Authorization = `Bearer ${token}`;
          }
          if (cachedHead?.etag) {
            headers["if-none-match"] = cachedHead.etag;
          }
          const response = await fetchImpl(
            `https://api.github.com/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repo)}/pulls/${reference.number}`,
            { headers },
          );
          recordGitHubRequest("ci-resolver", response);

          if (response.status === 304 && cachedHead?.headSha) {
            headSha = cachedHead.headSha;
            headRef = cachedHead.headRef;
            cachedHead.expiresAt = Date.now() + PR_HEAD_CACHE_TTL_MS;
          } else if (response.ok) {
            const data = (await response.json()) as { head?: { sha?: string; ref?: string } };
            if (data.head?.sha) {
              headSha = data.head.sha;
            }
            if (data.head?.ref) {
              headRef = data.head.ref;
            }
            const etag = getResponseHeader(response, "etag");
            prHeadCache.set(prKey, {
              headSha,
              headRef,
              etag,
              expiresAt: Date.now() + PR_HEAD_CACHE_TTL_MS,
            });
          } else if (response.status === 429 || response.status === 403) {
            const remaining = getResponseHeader(response, "x-ratelimit-remaining");
            const retryText = (await response.clone().text().catch(() => "")).toLowerCase();
            const rateLimited = response.status === 429 ||
              (response.status === 403 && (remaining === "0" || retryText.includes("rate limit")));
            if (rateLimited) {
              const resetSec = Number(getResponseHeader(response, "x-ratelimit-reset"));
              const resetStr = Number.isFinite(resetSec) && resetSec > 0
                ? formatUtcTime(new Date(resetSec * 1000))
                : getGitHubRateLimitResetTime() ?? "unknown";
              return {
                repository: repoKey,
                pullNumber: reference.number,
                headSha: null,
                headRef: null,
                status: "unavailable",
                conclusion: "rate_limited",
                summary: `checks unavailable (GitHub rate limit until ${resetStr})`,
                authoritative: false,
                checkedAt: new Date().toISOString(),
                completedAt: null,
                totalRuns: 0,
                successfulRuns: 0,
                failedRuns: 0,
                failedJobs: [],
                runs: [],
              };
            }
            return {
              repository: repoKey,
              pullNumber: reference.number,
              headSha: null,
              headRef: null,
              status: "unavailable",
              conclusion: "denied",
              summary: "checks unavailable (access denied)",
              authoritative: false,
              checkedAt: new Date().toISOString(),
              completedAt: null,
              totalRuns: 0,
              successfulRuns: 0,
              failedRuns: 0,
              failedJobs: [],
              runs: [],
            };
          } else if (response.status === 404) {
            return {
              repository: repoKey,
              pullNumber: reference.number,
              headSha: null,
              headRef: null,
              status: "unavailable",
              conclusion: "missing",
              summary: "pull request not found",
              authoritative: false,
              checkedAt: new Date().toISOString(),
              completedAt: null,
              totalRuns: 0,
              successfulRuns: 0,
              failedRuns: 0,
              failedJobs: [],
              runs: [],
            };
          }
        } catch {
          // ignore
        }
      }

      if (!headSha) {
        return {
          repository: repoKey,
          pullNumber: reference.number,
          headSha: null,
          headRef,
          status: "unknown",
          conclusion: "unknown",
          summary: "head SHA unknown",
          authoritative: false,
          checkedAt: new Date().toISOString(),
          completedAt: null,
          totalRuns: 0,
          successfulRuns: 0,
          failedRuns: 0,
          failedJobs: [],
          runs: [],
        };
      }

      const cacheKey = `${companyId}:${repoKey}@${headSha}`;
      const cached = ciCache.get(cacheKey);
      const commitCacheKey = `${repoKey}@${headSha}`;
      const rateLimited = isGitHubRateLimited();
      if (rateLimited) {
        const resetStr = getGitHubRateLimitResetTime() ?? "unknown";
        if (cached && cached.expiresAt > Date.now()) {
          return {
            ...cached.result,
            authoritative: false,
            conclusion: "rate_limited",
            summary: `${cached.result.summary} (устарел; GitHub rate limit until ${resetStr})`,
          };
        }
        const cachedRunsForHead = checkRunsCache.get(commitCacheKey);
        if (cachedRunsForHead) {
          const summarized = summarizeCheckRuns(cachedRunsForHead.runs, {
            headSha,
            repository: repoKey,
            pullNumber: reference.number,
          });
          return {
            repository: repoKey,
            pullNumber: reference.number,
            headSha,
            headRef,
            ...summarized,
            status: summarized.status,
            authoritative: false,
            conclusion: "rate_limited",
            summary: `${summarized.summary} (устарел; GitHub rate limit until ${resetStr})`,
            checkedAt: new Date().toISOString(),
            runs: cachedRunsForHead.runs,
          };
        }
        return {
          repository: repoKey,
          pullNumber: reference.number,
          headSha,
          headRef,
          status: "unavailable",
          conclusion: "rate_limited",
          summary: `checks unavailable (GitHub rate limit until ${resetStr})`,
          authoritative: false,
          checkedAt: new Date().toISOString(),
          completedAt: null,
          totalRuns: 0,
          successfulRuns: 0,
          failedRuns: 0,
          failedJobs: [],
          runs: [],
        };
      }
      if (cached && cached.expiresAt > Date.now()) {
        return cached.result;
      }

      let token: string | null = null;
      try {
        token = await tokenProvider(companyId, repoKey);
      } catch (err) {
        return {
          repository: repoKey,
          pullNumber: reference.number,
          headSha,
          headRef,
          status: "unavailable",
          conclusion: "unavailable",
          summary: `checks unavailable (token provider error: ${err instanceof Error ? err.message : "unknown"})`,
          authoritative: false,
          checkedAt: new Date().toISOString(),
          completedAt: null,
          totalRuns: 0,
          successfulRuns: 0,
          failedRuns: 0,
          failedJobs: [],
          runs: [],
        };
      }

      const cachedRunsEntry = checkRunsCache.get(commitCacheKey);
      let runs: CheckRunsFetchResult;
      try {
        runs = await fetchCommitCheckRuns(
          reference.owner,
          reference.repo,
          headSha,
          token,
          fetchImpl,
          { etag: cachedRunsEntry?.etag ?? undefined, cachedRuns: cachedRunsEntry },
        );
        if (runs.conclusion === "incomplete" && runs.summary === "checks unchanged (not modified)" && cachedRunsEntry) {
          runs = cachedRunsEntry.runs;
        } else if (runs.etag || cachedRunsEntry) {
          checkRunsCache.set(commitCacheKey, {
            etag: runs.etag ?? cachedRunsEntry?.etag,
            runs,
            expiresAt: Date.now() + (runs.status === "completed" ? CI_CACHE_COMPLETED_TTL_MS : CI_CACHE_INCOMPLETE_TTL_MS),
          });
        }
      } catch (err) {
        return {
          repository: repoKey,
          pullNumber: reference.number,
          headSha,
          headRef,
          status: "unavailable",
          conclusion: "unavailable",
          summary: `checks unavailable (${err instanceof Error ? err.message : "error"})`,
          authoritative: false,
          checkedAt: new Date().toISOString(),
          completedAt: null,
          totalRuns: 0,
          successfulRuns: 0,
          failedRuns: 0,
          failedJobs: [],
          runs: [],
        };
      }
      const summarized = summarizeCheckRuns(runs, {
        headSha,
        repository: repoKey,
        pullNumber: reference.number,
      });
      if (summarized.totalRuns === 0 && runs.conclusion !== "rate_limited") {
        const hostedCi = await repositoryHasHostedCi({ ...reference, token, fetch: fetchImpl });
        if (hostedCi === false) {
          summarized.status = "not_configured";
          summarized.conclusion = "not_configured";
          summarized.summary = NO_HOSTED_CI_SUMMARY;
          summarized.authoritative = true;
        }
      }

      const isRateLimited = runs.conclusion === "rate_limited" || isGitHubRateLimited();
      const result: PullRequestCiResult = {
        repository: repoKey,
        pullNumber: reference.number,
        headSha,
        headRef,
        ...summarized,
        conclusion: isRateLimited ? "rate_limited" : summarized.conclusion,
        summary: runs.conclusion === "rate_limited" && runs.summary ? runs.summary : summarized.summary,
        checkedAt: new Date().toISOString(),
        runs,
      };

      const ttlMs = result.status === "completed" || result.status === "not_configured" ? CI_CACHE_COMPLETED_TTL_MS : CI_CACHE_INCOMPLETE_TTL_MS;
      if (ciCache.size >= CI_CACHE_MAX_ENTRIES) {
        const oldestKey = ciCache.keys().next().value;
        if (oldestKey !== undefined) ciCache.delete(oldestKey);
      }
      if (result.conclusion !== "rate_limited") {
        ciCache.set(cacheKey, {
          expiresAt: Date.now() + ttlMs,
          result,
        });
      }

      return result;
    },

    async resolveForIssue(companyId: string, issueId: string): Promise<PullRequestCiResult[]> {
      const references = new Map<string, GitHubPullRequestReference>();
      const addRef = (ref: GitHubPullRequestReference) => {
        const key = `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;
        if (!references.has(key)) {
          references.set(key, ref);
        }
      };

      // 1. Work products for this issue. myrmidon(OPE-12397): only live PR
      // products — a merged/closed PR cannot change its CI, and re-reading it
      // on every wake burned the rate budget; terminal products keep their
      // stored metadata.
      const products = (
        await db
          .select()
          .from(issueWorkProducts)
          .where(
            and(
              eq(issueWorkProducts.companyId, companyId),
              eq(issueWorkProducts.issueId, issueId),
            ),
          )
      ).filter((product) => {
        if (product.type !== "pull_request") return false;
        const status = typeof product.status === "string" ? product.status.toLowerCase() : "";
        if (TERMINAL_PULL_REQUEST_PRODUCT_STATUSES.has(status)) return false;
        const metaState = (product.metadata as Record<string, unknown> | null)?.state;
        return !(typeof metaState === "string" && TERMINAL_PULL_REQUEST_PRODUCT_STATUSES.has(metaState.toLowerCase()));
      });

      for (const product of products) {
        const candidateTexts: unknown[] = [product.url, product.title];
        if (product.metadata && typeof product.metadata === "object") {
          const meta = product.metadata as Record<string, unknown>;
          candidateTexts.push(meta.url, meta.prUrl, meta.html_url);
          const repo = typeof meta.repo === "string" ? meta.repo : typeof meta.repository === "string" ? meta.repository : null;
          const num = typeof meta.number === "number" ? meta.number : typeof meta.prNumber === "number" ? meta.prNumber : null;
          if (repo && num) {
            candidateTexts.push(`${repo}#${num}`);
          }
          try {
            candidateTexts.push(JSON.stringify(meta));
          } catch {
            // ignore JSON error
          }
        }
        for (const ref of extractGitHubPullRequestReferences(candidateTexts)) {
          addRef(ref);
        }
      }

      // 2. Issue description and title
      const [issue] = await db
        .select({ description: issues.description, title: issues.title })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
      if (issue) {
        for (const ref of extractGitHubPullRequestReferences([issue.description, issue.title])) {
          addRef(ref);
        }
      }

      // 3. Issue comments
      const comments = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, companyId),
            eq(issueComments.issueId, issueId),
            isNull(issueComments.deletedAt),
          ),
        );
      for (const comment of comments) {
        if (comment.body) {
          for (const ref of extractGitHubPullRequestReferences([comment.body])) {
            addRef(ref);
          }
        }
      }

      // 4. Child issues (e.g. delegated deployment or sub-tasks)
      const childIssues = await db
        .select({ id: issues.id, description: issues.description, title: issues.title })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.parentId, issueId)));

      for (const child of childIssues) {
        for (const ref of extractGitHubPullRequestReferences([child.description, child.title])) {
          addRef(ref);
        }
        const childProducts = await db
          .select()
          .from(issueWorkProducts)
          .where(
            and(
              eq(issueWorkProducts.companyId, companyId),
              eq(issueWorkProducts.issueId, child.id),
            ),
          );
        for (const cp of childProducts) {
          const candidateTexts: unknown[] = [cp.url, cp.title];
          if (cp.metadata && typeof cp.metadata === "object") {
            const meta = cp.metadata as Record<string, unknown>;
            candidateTexts.push(meta.url, meta.prUrl, meta.html_url);
            const repo = typeof meta.repo === "string" ? meta.repo : typeof meta.repository === "string" ? meta.repository : null;
            const num = typeof meta.number === "number" ? meta.number : typeof meta.prNumber === "number" ? meta.prNumber : null;
            if (repo && num) {
              candidateTexts.push(`${repo}#${num}`);
            }
          }
          for (const ref of extractGitHubPullRequestReferences(candidateTexts)) {
            addRef(ref);
          }
        }
      }

      const results: PullRequestCiResult[] = [];
      // myrmidon(OPE-12397): a ceiling on the GitHub reads one wake build
      // spends — the task's own products come first in insertion order, then
      // description, comments and children; beyond the cap, older references
      // (duplicates aside) are dropped.
      const cappedReferences = [...references.values()].slice(0, CI_RESOLVE_FOR_ISSUE_MAX_REFS);
      for (const reference of cappedReferences) {
        try {
          const result = await this.resolveForPullRequest(companyId, reference);
          results.push(result);
        } catch (err) {
          results.push({
            repository: `${reference.owner}/${reference.repo}`,
            pullNumber: reference.number,
            headSha: null,
            headRef: null,
            status: "unavailable",
            conclusion: "unavailable",
            summary: `checks unavailable (${err instanceof Error ? err.message : "error"})`,
            authoritative: false,
            checkedAt: new Date().toISOString(),
            completedAt: null,
            totalRuns: 0,
            successfulRuns: 0,
            failedRuns: 0,
            failedJobs: [],
            runs: [],
          });
        }
      }
      return results;
    },
  };
}

export type PullRequestHeadLane = "test" | "lint";

export interface PullRequestHeadLaneEvidence {
  lane: PullRequestHeadLane;
  name: string;
  headSha: string | null;
  state: "success" | "failure" | "pending" | "missing" | "unknown";
  status: "queued" | "in_progress" | "completed" | "missing" | "unknown";
  conclusion: string | null;
  finishedAt: string | null;
}

export function isTestCheckRun(name: string): boolean {
  const n = name.trim().toLowerCase();
  return (
    /\b(test|tests|vitest|jest|pytest)\b/.test(n) ||
    n.startsWith("tests (") ||
    n.startsWith("test (")
  );
}

export function isLintCheckRun(name: string): boolean {
  const n = name.trim().toLowerCase();
  return (
    /\b(lint|linter|typecheck|type-check|checks|eslint|biome)\b/.test(n) ||
    n.startsWith("checks (") ||
    n.includes("typecheck")
  );
}

export function summarizeHeadLaneEvidence(
  runs: readonly PullRequestCiJob[],
  options?: { headSha?: string | null },
): PullRequestHeadLaneEvidence[] {
  const headSha = options?.headSha ?? null;
  // myrmidon(LANE-EVIDENCE-CANCELLED-2, OPE-13089): apply the same representative check selection
  // as summarizeCheckRuns so cancelled checks superseded by newer runs do not keep the lane red.
  const effectiveRuns = selectRepresentativeRuns(runs);
  const testRuns = effectiveRuns.filter((r) => isTestCheckRun(r.name));
  const lintRuns = effectiveRuns.filter((r) => isLintCheckRun(r.name));

  const successfulCiResults = runs.filter(
    (r) => r.name.trim().toLowerCase() === "ci result" && r.conclusion === "success",
  );
  const latestSuccessfulCiResult = latestOf(successfulCiResults);

  function summarizeLane(
    lane: PullRequestHeadLane,
    laneRuns: readonly PullRequestCiJob[],
  ): PullRequestHeadLaneEvidence {
    if (laneRuns.length === 0) {
      return {
        lane,
        name: lane,
        headSha,
        state: "missing",
        status: "missing",
        conclusion: null,
        finishedAt: null,
      };
    }

    const pendingRun = laneRuns.find(
      (r) => r.status === "queued" || r.status === "in_progress" || (r.status as string) === "pending",
    );
    if (pendingRun) {
      return {
        lane,
        name: pendingRun.name,
        headSha,
        state: "pending",
        status: pendingRun.status,
        conclusion: pendingRun.conclusion,
        finishedAt: null,
      };
    }

    const failedRun = laneRuns.find((r) => {
      if (!r.conclusion || r.conclusion === "success" || r.conclusion === "neutral" || r.conclusion === "skipped") {
        return false;
      }
      // myrmidon(LANE-EVIDENCE-CANCELLED, OPE-13072): a cancelled check does not
      // make the lane red if it is not newer than a successful CI result of the same head.
      if (
        r.conclusion === "cancelled" &&
        latestSuccessfulCiResult &&
        compareRuns(r, latestSuccessfulCiResult) <= 0
      ) {
        return false;
      }
      return true;
    });

    if (failedRun) {
      return {
        lane,
        name: failedRun.name,
        headSha,
        state: "failure",
        status: failedRun.status,
        conclusion: failedRun.conclusion,
        finishedAt: failedRun.completedAt ?? null,
      };
    }

    let latestCompletedAt: string | null = null;
    for (const r of laneRuns) {
      if (r.completedAt) {
        if (!latestCompletedAt || new Date(r.completedAt).getTime() > new Date(latestCompletedAt).getTime()) {
          latestCompletedAt = r.completedAt;
        }
      }
    }

    return {
      lane,
      name: lane,
      headSha,
      state: "success",
      status: "completed",
      conclusion: "success",
      finishedAt: latestCompletedAt ?? latestSuccessfulCiResult?.completedAt ?? null,
    };
  }

  return [summarizeLane("test", testRuns), summarizeLane("lint", lintRuns)];
}

/**
 * myrmidon(1.7-GOAL-JUDGE): formats authoritative pull request CI test / check runs
 * into structured text suitable for goal-judge evaluation and review verification.
 */
export function formatAuthoritativeCiOutput(
  ciResults: readonly PullRequestCiResult[],
): string | null {
  if (!ciResults || ciResults.length === 0) return null;
  const sections: string[] = [];
  for (const ci of ciResults) {
    const lines: string[] = [];
    lines.push(`PR #${ci.pullNumber} (${ci.repository}):`);
    if (ci.headSha) lines.push(`Head SHA: ${ci.headSha}`);
    lines.push(
      `CI Status: ${ci.status}, Conclusion: ${ci.conclusion} (Authoritative: ${ci.authoritative ? "true" : "false"})`,
    );
    lines.push(`Summary: ${ci.summary}`);
    if (ci.failedJobs.length > 0) {
      lines.push("Failed checks:");
      for (const job of ci.failedJobs) {
        lines.push(`  - ${job.name}: ${job.conclusion}${job.url ? ` (${job.url})` : ""}`);
      }
    }
    if (ci.cancelledJobs && ci.cancelledJobs.length > 0) {
      lines.push("Cancelled checks (cancelled, not a test failure):");
      for (const job of ci.cancelledJobs) {
        lines.push(`  - ${job.name}: ${job.conclusion}${job.url ? ` (${job.url})` : ""}`);
      }
    }
    if (ci.runs.length > 0) {
      lines.push("Check runs:");
      for (const run of ci.runs) {
        lines.push(
          `  - ${run.name}: ${run.status}/${run.conclusion ?? "pending"}${run.url ? ` (${run.url})` : ""}`,
        );
      }
    }
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n");
}
