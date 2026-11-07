import type { Db } from "@myrmidon/db";
import { and, eq, isNull } from "drizzle-orm";
import { issueWorkProducts, issues, issueComments } from "@myrmidon/db";
import { DEFAULT_GITHUB_TOKEN_SECRET_NAMES } from "./git-credentials.js";
import { repositoryHasHostedCi, NO_HOSTED_CI_SUMMARY } from "./github-hosted-ci.js";
import type { FetchLike } from "./github-external-object-provider.js";
import { resolveGitHubRepositoryToken } from "./github-external-object-provider.js";
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
  runs: PullRequestCiJob[];
}

export function summarizeCheckRuns(
  runs: readonly PullRequestCiJob[],
  _options?: { headSha?: string | null; repository?: string; pullNumber?: number },
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
    };
  }

  const totalRuns = runs.length;
  if (totalRuns === 0) {
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
    };
  }

  const failedJobs: PullRequestFailedJob[] = [];
  let successfulRuns = 0;
  let inProgressCount = 0;
  let latestCompletedAt: string | null = null;

  for (const run of runs) {
    if (run.completedAt) {
      if (!latestCompletedAt || new Date(run.completedAt).getTime() > new Date(latestCompletedAt).getTime()) {
        latestCompletedAt = run.completedAt;
      }
    }

    if (run.status !== "completed") {
      inProgressCount++;
      continue;
    }

    const conclusion = run.conclusion;
    if (conclusion === "success" || conclusion === "skipped" || conclusion === "neutral") {
      successfulRuns++;
    } else if (
      conclusion === "failure" ||
      conclusion === "timed_out" ||
      conclusion === "action_required" ||
      conclusion === "cancelled"
    ) {
      failedJobs.push({
        id: run.id,
        name: run.name,
        conclusion: conclusion ?? "failure",
        url: run.url,
        completedAt: run.completedAt,
      });
    } else {
      failedJobs.push({
        id: run.id,
        name: run.name,
        conclusion: conclusion ?? "unknown",
        url: run.url,
        completedAt: run.completedAt,
      });
    }
  }

  const failedRuns = failedJobs.length;
  let status: PullRequestCiStatus;
  let conclusion: PullRequestCiConclusion;
  let summary: string;

  if (failedRuns > 0) {
    conclusion = "failure";
    status = inProgressCount > 0 ? "in_progress" : "completed";
    summary = `failure (${failedRuns} failed, ${successfulRuns} passed${inProgressCount > 0 ? `, ${inProgressCount} running` : ""})`;
  } else if (inProgressCount > 0) {
    status = "in_progress";
    conclusion = "pending";
    summary = `in progress (${inProgressCount} running, ${successfulRuns} passed)`;
  } else {
    status = "completed";
    conclusion = "success";
    summary = `success (${successfulRuns}/${totalRuns} passed)`;
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
  options: PullRequestCiResolverOptions = {},
): PullRequestCiResolver {
  const rawFetch = options.fetch ?? fetch;
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

      // 1. Work products for this issue
      const products = await db
        .select()
        .from(issueWorkProducts)
        .where(
          and(
            eq(issueWorkProducts.companyId, companyId),
            eq(issueWorkProducts.issueId, issueId),
          ),
        );

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
      for (const reference of references.values()) {
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
