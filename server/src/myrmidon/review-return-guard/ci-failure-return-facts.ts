// myrmidon(EMPTY-RUNS-3, REVIEW-RETURN-GUARD): the GitHub read behind the CI
// return decision (./ci-failure-return.ts) — the check runs of the head of one
// pull request, read at the moment of the webhook delivery.
//
// Kept apart from the pure decision so that the GitHub connection events, which
// only decide, do not pull the token and secret services into their imports;
// server/src/index.ts wires this reader into the event service. The token path
// is the one every other CI read of the board uses (github-ci.ts): a company
// secret, otherwise a read-only installation token of the shared GitHub App,
// otherwise an anonymous read. Any trouble answers "unknown" with a short
// reason, never a token.

import type { Db } from "@myrmidon/db";
import { DEFAULT_GITHUB_TOKEN_SECRET_NAMES } from "../../services/git-credentials.js";
import { defaultTokenProvider as resolveGitHubReadToken } from "../../services/github-external-object-provider.js";
import { extractGitHubPullRequestReferences } from "../../services/github-pull-request-merge.js";
import { readPullRequestHeadCheckRunsNow } from "../review-stage-recovery/github-ci.js";
import type { CiReturnFactsResolver } from "./ci-failure-return.js";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function createCiReturnFactsResolver(input: {
  db: Db;
  fetch?: FetchLike;
  tokenProvider?: (companyId: string, repository: string) => Promise<string | null>;
}): CiReturnFactsResolver {
  const tokenProvider =
    input.tokenProvider ??
    ((companyId: string, repository: string) =>
      resolveGitHubReadToken(input.db, companyId, repository, DEFAULT_GITHUB_TOKEN_SECRET_NAMES, input.fetch));

  return async ({ companyId, repository, pullRequestNumber, headSha }) => {
    const reference = extractGitHubPullRequestReferences([`${repository}#${pullRequestNumber}`])[0] ?? null;
    if (!reference) return { state: "unknown", reason: "pull_request_reference_unreadable" };
    let token: string | null = null;
    try {
      token = (await tokenProvider(companyId, `${reference.owner}/${reference.repo}`))?.trim() || null;
    } catch {
      // Anonymous read: the repository may be public; a failed read answers "unknown" below.
    }
    try {
      return await readPullRequestHeadCheckRunsNow({ reference, token, headSha, fetch: input.fetch });
    } catch {
      return { state: "unknown", reason: "read_failed" };
    }
  };
}
