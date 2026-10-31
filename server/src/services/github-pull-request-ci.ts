import type { Db } from "@myrmidon/db";
import { and, eq, isNull } from "drizzle-orm";
import { issueWorkProducts, issues, issueComments } from "@myrmidon/db";
import { DEFAULT_GITHUB_TOKEN_SECRET_NAMES } from "./git-credentials.js";
import type { FetchLike } from "./github-external-object-provider.js";
import { resolveGitHubRepositoryToken } from "./github-external-object-provider.js";
import type { GitHubPullRequestReference } from "./github-pull-request-merge.js";
import {
  createPullRequestMergeDetailsResolver,
  extractGitHubPullRequestReferences,
} from "./github-pull-request-merge.js";

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
  | "missing"
  | "denied"
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
    meta?.conclusion === "incomplete"
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
};

export async function fetchCommitCheckRuns(
  owner: string,
  repo: string,
  headSha: string,
  token: string | null,
  fetchImpl: FetchLike = fetch,
  options: { maxPages?: number } = {},
): Promise<CheckRunsFetchResult> {
  const maxPages = options.maxPages ?? 10;
  const allRuns: PullRequestCiJob[] = [];
  let page = 1;
  let totalCount: number | null = null;
  let fetchFailed = false;
  let failStatus: number | null = null;

  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "myrmidon-ci-resolver",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  while (page <= maxPages) {
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(headSha)}/check-runs?per_page=100&page=${page}&filter=latest`;
    let res: Response;
    try {
      res = await fetchImpl(url, { headers });
    } catch {
      fetchFailed = true;
      break;
    }

    if (!res.ok) {
      failStatus = res.status;
      fetchFailed = true;
      break;
    }

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
      break;
    }

    page++;
  }

  const result = allRuns as CheckRunsFetchResult;

  if (fetchFailed && allRuns.length === 0) {
    result.authoritative = false;
    if (failStatus === 404) {
      result.status = "unavailable";
      result.conclusion = "missing";
      result.summary = "checks missing (commit or check-runs not found)";
    } else if (failStatus === 403 || failStatus === 401) {
      result.status = "unavailable";
      result.conclusion = "denied";
      result.summary = "checks unavailable (access denied)";
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
    reference: GitHubPullRequestReference,
  ): Promise<PullRequestCiResult>;
  resolveForIssue(companyId: string, issueId: string): Promise<PullRequestCiResult[]>;
}

const CI_CACHE_MAX_ENTRIES = 500;
const CI_CACHE_TTL_MS = 15_000; // 15s cache to avoid rate limits during single run

interface CacheEntry {
  expiresAt: number;
  result: PullRequestCiResult;
}

const ciCache = new Map<string, CacheEntry>();

export function createPullRequestCiResolver(
  db: Db,
  options: PullRequestCiResolverOptions = {},
): PullRequestCiResolver {
  const fetchImpl = options.fetch ?? fetch;
  const secretNames = options.secretNames ?? DEFAULT_GITHUB_TOKEN_SECRET_NAMES;
  const tokenProvider =
    options.tokenProvider ??
    ((companyId: string, repository: string) =>
      resolveGitHubRepositoryToken(db, companyId, repository, secretNames, fetchImpl));
  const prResolver = options.prResolver ?? createPullRequestMergeDetailsResolver(db);

  return {
    async resolveForPullRequest(
      companyId: string,
      reference: GitHubPullRequestReference,
    ): Promise<PullRequestCiResult> {
      const repoKey = `${reference.owner}/${reference.repo}`;
      const prDetails = await prResolver(companyId, reference);
      let headSha = prDetails.headSha;
      let headRef = prDetails.headRef;

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
          const response = await fetchImpl(
            `https://api.github.com/repos/${reference.owner}/${reference.repo}/pulls/${reference.number}`,
            { headers },
          );
          if (response.ok) {
            const data = (await response.json()) as { head?: { sha?: string; ref?: string } };
            if (data.head?.sha) {
              headSha = data.head.sha;
            }
            if (data.head?.ref) {
              headRef = data.head.ref;
            }
          } else if (response.status === 401 || response.status === 403) {
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
      if (cached && cached.expiresAt > Date.now()) {
        return cached.result;
      }

      const token = await tokenProvider(companyId, repoKey);
      const runs = await fetchCommitCheckRuns(
        reference.owner,
        reference.repo,
        headSha,
        token,
        fetchImpl,
      );
      const summary = summarizeCheckRuns(runs, {
        headSha,
        repository: repoKey,
        pullNumber: reference.number,
      });

      const result: PullRequestCiResult = {
        repository: repoKey,
        pullNumber: reference.number,
        headSha,
        headRef,
        ...summary,
        checkedAt: new Date().toISOString(),
        runs,
      };

      if (ciCache.size >= CI_CACHE_MAX_ENTRIES) {
        const oldestKey = ciCache.keys().next().value;
        if (oldestKey !== undefined) ciCache.delete(oldestKey);
      }
      ciCache.set(cacheKey, {
        expiresAt: Date.now() + CI_CACHE_TTL_MS,
        result,
      });

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
            isNull(issueWorkProducts.deletedAt),
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
        .where(and(eq(issues.companyId, companyId), eq(issues.parentId, issueId), isNull(issues.deletedAt)));

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
              isNull(issueWorkProducts.deletedAt),
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
        const result = await this.resolveForPullRequest(companyId, reference);
        results.push(result);
      }
      return results;
    },
  };
}
