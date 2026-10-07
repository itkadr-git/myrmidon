// server/src/myrmidon/review-rework/resolver.ts
//
// myrmidon(REVIEW-REWORK): the GitHub half of the sweep's facts. Reads the
// same provider the vendor's merge-details resolver uses, but keeps the two
// fields this loop needs and the merge path does not: the aggregate review
// decision and the remote `updated_at`. A new file so the vendor seam stays
// untouched; the object identity shape is the provider's own.

import type { Db } from "@paperclipai/db";
import { createGitHubExternalObjectProvider } from "../../services/github-external-object-provider.js";
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
export function createPullRequestReviewFactsResolver(db: Db): ReviewReworkPrResolver {
  let resolverPromise: Promise<ReturnType<typeof pickResolver>> | null = null;
  const pickResolver = () =>
    createGitHubExternalObjectProvider(db).resolvers.find(
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
