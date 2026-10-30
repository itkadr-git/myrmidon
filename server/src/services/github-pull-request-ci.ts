import type { Db } from "@myrmidon/db";
import { and, eq, isNull } from "drizzle-orm";
import { issueWorkProducts, issues } from "@myrmidon/db";
import type { FetchLike } from "./github-external-object-provider.js";
import {
  DEFAULT_GITHUB_TOKEN_SECRET_NAMES,
  resolveGitHubRepositoryToken,
} from "./github-external-object-provider.js";
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
  | "unknown";

export interface PullRequestCiResult {
  repository: string;
  pullNumber: number;
  headSha: string | null;
  headRef: string | null;
  status: PullRequestCiStatus;
  conclusion: PullRequestCiConclusion;
  summary: string;
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
  completedAt: string | null;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  failedJobs: PullRequestFailedJob[];
} {
  const totalRuns = runs.length;
  if (totalRuns === 0) {
    return {
      status: "pending",
      conclusion: "no_checks",
      summary: "no checks reported",
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
    completedAt: latestCompletedAt,
    totalRuns,
    successfulRuns,
    failedRuns,
    failedJobs,
  };
}

export async function fetchCommitCheckRuns(
  owner: string,
  repo: string,
  headSha: string,
  token: string | null,
  fetchImpl: FetchLike = fetch,
): Promise<PullRequestCiJob[]> {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(headSha)}/check-runs?per_page=100&filter=latest`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "myrmidon-ci-resolver",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  const res = await fetchImpl(url, { headers });
  if (!res.ok) {
    if (res.status === 404 || res.status === 422) {
      return [];
    }
    throw new Error(`GitHub check-runs API returned HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
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
  };

  const checkRuns = Array.isArray(data.check_runs) ? data.check_runs : [];
  return checkRuns.map((cr) => ({
    id: cr.id,
    name: cr.name,
    status: (cr.status === "completed" || cr.status === "in_progress" || cr.status === "queued"
      ? cr.status
      : "in_progress") as "queued" | "in_progress" | "completed",
    conclusion: cr.conclusion as PullRequestCiJob["conclusion"],
    url: cr.html_url,
    startedAt: cr.started_at ?? null,
    completedAt: cr.completed_at ?? null,
  }));
}

export interface PullRequestCiResolverOptions {
  fetch?: FetchLike;
  tokenProvider?: (companyId: string, repository: string) => Promise<string | null> | string | null;
  secretNames?: readonly string[];
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
  const prResolver = createPullRequestMergeDetailsResolver(db);

  return {
    async resolveForPullRequest(
      companyId: string,
      reference: GitHubPullRequestReference,
    ): Promise<PullRequestCiResult> {
      const repoKey = `${reference.owner}/${reference.repo}`;
      const prDetails = await prResolver(companyId, reference);
      const headSha = prDetails.headSha;
      const headRef = prDetails.headRef;

      if (!headSha) {
        return {
          repository: repoKey,
          pullNumber: reference.number,
          headSha: null,
          headRef,
          status: "unknown",
          conclusion: "unknown",
          summary: "head SHA unknown",
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

      const references = new Map<string, GitHubPullRequestReference>();
      for (const product of products) {
        if (product.type !== "pull_request" && product.type !== "pullRequest") continue;
        const refs = extractGitHubPullRequestReferences([product.url, product.title]);
        for (const [key, ref] of refs.entries()) {
          references.set(key, ref);
        }
      }

      if (references.size === 0) {
        const [issue] = await db
          .select({ description: issues.description })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
        if (issue?.description) {
          const refs = extractGitHubPullRequestReferences([issue.description]);
          for (const [key, ref] of refs.entries()) {
            references.set(key, ref);
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
