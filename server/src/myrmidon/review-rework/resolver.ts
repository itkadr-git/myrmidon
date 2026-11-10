// server/src/myrmidon/review-rework/resolver.ts
//
// myrmidon(REVIEW-REWORK): the GitHub half of the sweep's facts. Reads the
// same provider the vendor's merge-details resolver uses, but keeps the two
// fields this loop needs and the merge path does not: the aggregate review
// decision and the remote `updated_at`. A new file so the vendor seam stays
// untouched; the object identity shape is the provider's own.

import type { Db } from "@myrmidon/db";
import {
  createGitHubExternalObjectProvider,
  resolveGitHubRepositoryToken,
  type FetchLike,
  type GitHubExternalObjectProviderOptions,
} from "../../services/github-external-object-provider.js";
import { DEFAULT_GITHUB_TOKEN_SECRET_NAMES } from "../../services/git-credentials.js";
import {
  recordGitHubRequest,
  isGitHubRateLimited,
} from "../../services/github-rate-limit.js";
import type { ReviewReworkPrState } from "./domain.js";

export interface ReviewReworkPrReference {
  owner: string;
  repo: string;
  number: number;
}

export interface ReviewReworkPrSnapshot {
  state: ReviewReworkPrState;
  headSha: string | null;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | null;
  /** The PR's remote `updated_at` (ISO), when the provider reported it. */
  updatedAt: string | null;
  /** Unified diff of the pull request, when resolved. */
  diff?: string | null;
  /** Authoritative test / CI output, when resolved. */
  ciOutput?: string | null;
}

export type ReviewReworkPrResolver = (
  companyId: string,
  reference: ReviewReworkPrReference,
) => Promise<ReviewReworkPrSnapshot>;

const UNKNOWN: ReviewReworkPrSnapshot = {
  state: "unknown",
  headSha: null,
  reviewDecision: null,
  updatedAt: null,
  diff: null,
  ciOutput: null,
};

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readDecision(value: unknown): ReviewReworkPrSnapshot["reviewDecision"] {
  return value === "APPROVED" || value === "CHANGES_REQUESTED" || value === "COMMENTED"
    ? value
    : null;
}

/**
 * The provider-backed resolver. A failure (no token, unreachable, invalid
 * identity) reads as `unknown`: the sweep never acts on an unresolved PR, so
 * a GitHub outage cannot invent a merge, a head move, or a verdict.
 */
export function createPullRequestReviewFactsResolver(
  db: Db,
  opts: GitHubExternalObjectProviderOptions = {},
): ReviewReworkPrResolver {
  let resolverPromise: Promise<ReturnType<typeof pickResolver>> | null = null;
  const pickResolver = () =>
    createGitHubExternalObjectProvider(db, { source: "review-rework", ...opts }).resolvers.find(
      (candidate) => candidate.objectType === "pull_request",
    ) ?? null;

  return async (companyId, reference) => {
    resolverPromise ??= Promise.resolve(pickResolver());
    const resolver = await resolverPromise;
    if (!resolver) return UNKNOWN;
    const result = await resolver.resolve({
      companyId,
      object: {
        externalId: `${reference.owner}/${reference.repo}#pull/${reference.number}`,
        sanitizedCanonicalUrl: `https://github.com/${reference.owner}/${reference.repo}/pull/${reference.number}`,
      } as never,
    });
    if (!result.ok) return UNKNOWN;
    const data = readRecord(result.snapshot.data);
    const statusKey = result.snapshot.statusKey;
    const state: ReviewReworkPrState =
      statusKey === "open" || statusKey === "draft" || statusKey === "merged" || statusKey === "closed"
        ? statusKey
        : "unknown";
    return {
      state,
      headSha: typeof data?.headSha === "string" ? data.headSha : null,
      reviewDecision: readDecision(data?.reviewDecision),
      updatedAt:
        typeof result.snapshot.remoteVersion === "string" ? result.snapshot.remoteVersion : null,
    };
  };
}

export type ReviewReworkDiffResolver = (
  companyId: string,
  reference: ReviewReworkPrReference & { headSha?: string | null },
) => Promise<string | null>;

export const MAX_DIFF_LENGTH = 100_000;

/**
 * Resolves the actual unified diff of a pull request from GitHub.
 * Caches by company, repo, number and headSha to avoid re-fetching unchanged heads.
 */
export function createPullRequestDiffResolver(
  db: Db,
  opts: {
    source?: string;
    fetch?: FetchLike;
    secretNames?: readonly string[];
  } = {},
): ReviewReworkDiffResolver {
  const fetchImpl: FetchLike = opts.fetch ?? fetch;
  const secretNames = opts.secretNames ?? DEFAULT_GITHUB_TOKEN_SECRET_NAMES;
  const diffCache = new Map<string, { diff: string; expiresAt: number }>();
  const DIFF_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

  return async (companyId, reference) => {
    const repoKey = `${reference.owner}/${reference.repo}`;
    const cacheKey = reference.headSha
      ? `${companyId}:${repoKey}#${reference.number}@${reference.headSha}`
      : `${companyId}:${repoKey}#${reference.number}`;

    const cached = diffCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.diff;
    }

    if (isGitHubRateLimited()) {
      return cached?.diff ?? null;
    }

    try {
      const token = await resolveGitHubRepositoryToken(db, companyId, repoKey, secretNames, fetchImpl);
      const url = `https://api.github.com/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repo)}/pulls/${reference.number}`;
      const headers: Record<string, string> = {
        Accept: "application/vnd.github.v3.diff",
        "User-Agent": "Myrmidon-Diff-Resolver",
      };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      const response = await fetchImpl(url, { headers });
      recordGitHubRequest("review-rework", response);
      if (!response.ok) {
        return null;
      }
      let diff = await response.text();
      if (diff.length > MAX_DIFF_LENGTH) {
        diff = diff.slice(0, MAX_DIFF_LENGTH) + `\n\n... [diff truncated: ${diff.length - MAX_DIFF_LENGTH} characters omitted]`;
      }
      diffCache.set(cacheKey, { diff, expiresAt: Date.now() + DIFF_CACHE_TTL_MS });
      return diff;
    } catch {
      return null;
    }
  };
}
