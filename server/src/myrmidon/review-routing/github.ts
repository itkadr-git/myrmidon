// myrmidon(REVIEW-ROUTING): the GitHub resolver of the PR lane — what one
// pull request head actually looks like right now (CI verdict + aggregate
// review decision derived from the reviews list), read through the same token path the Cloud-connector
// provider uses (DEFAULT_GITHUB_TOKEN_SECRET_NAMES via the secrets service,
// ghFetch/gitHubApiBase from services/github-fetch.js — vendor helpers, not
// edited).
//
// A fetch failure NEVER guesses: it reads as `fetchFailed: true` / ci
// "unknown", and the sweep skips the PR this pass. A GitHub outage must not
// create or close board tasks. The PR body is read fresh every pass (a pushed
// head changes it), while the per-head status read — keyed by the exact
// headSha — is TTL-cached per (company, repo, number, headSha) with the
// provider's 300 s cache (GITHUB_OBJECT_TTL_SECONDS of
// github-external-object-provider.ts).
//
// myrmidon(UPDATE-BRANCH-STEWARD): the merge path the lane routes to is
// update-branch, not a hosted ordering feature: an approved green head gets
// a steward task whose first command is `gh pr update-branch` (GitHub's
// PUT /pulls/{n}/update-branch — a no-op on an already-current branch), and
// only the CURRENT head may be merged. The per-head review fold above is
// what makes the wait safe: update-branch pushes a refresh commit, the head
// moves, the approval and the green run of the old head no longer cover the
// merge, the stale merge task is cancelled as superseded, and the lane
// routes the refreshed head through review and merge on its own fresh
// verdicts.

import type { Db } from "@paperclipai/db";
import { DEFAULT_GITHUB_TOKEN_SECRET_NAMES } from "../../services/git-credentials.js";
import { ghFetch, gitHubApiBase } from "../../services/github-fetch.js";
import { secretService } from "../../services/secrets.js";
import type { PullRequestHeadState, PullRequestReviewDecision } from "./pr-policy.js";

/** Same TTL as the external-object provider (GITHUB_OBJECT_TTL_SECONDS). */
export const PR_HEAD_STATE_TTL_MS = 300_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function failedHead(repository: string, number: number): PullRequestHeadState {
  return {
    repository,
    number,
    open: false,
    draft: false,
    headSha: null,
    ci: "unknown",
    reviewDecision: null,
    fetchFailed: true,
  };
}

/**
 * Combined status of a head: "success" and NO statuses at all are green (a
 * repo without CI); pending / failure / error are not green, and neither is
 * anything the resolver could not read.
 */
export function pullRequestCiStateFromStatusPayload(status: Record<string, unknown>): "green" | "not_green" {
  const state = asString(status.state);
  if (state === "success") return "green";
  if (state === "pending" || state === "failure" || state === "error") return "not_green";
  const statuses = Array.isArray(status.statuses) ? status.statuses : null;
  if (statuses !== null && statuses.length === 0) return "green";
  return "not_green";
}

/**
 * Aggregate review decision of the CURRENT head, derived from the REST
 * `GET /pulls/{n}/reviews` list (the REST pull request object has no review
 * decision field; `reviewDecision` exists only in GraphQL). Per reviewer the
 * latest decisive review wins (APPROVED / CHANGES_REQUESTED / DISMISSED;
 * COMMENTED and PENDING never change a verdict). Only a verdict left on the
 * exact `headSha` counts, so an approval of an older head cannot survive a
 * push. Any standing CHANGES_REQUESTED outranks approvals; otherwise any
 * APPROVED is APPROVED; no verdict is null.
 */
export function pullRequestReviewDecisionFromReviews(reviews: unknown[], headSha: string): PullRequestReviewDecision {
  const latestByReviewer = new Map<string, { state: string; commit: string | null }>();
  for (const entry of reviews) {
    const review = asRecord(entry);
    if (!review) continue;
    const state = (asString(review.state) ?? "").trim().toUpperCase();
    if (state !== "APPROVED" && state !== "CHANGES_REQUESTED" && state !== "DISMISSED") continue;
    const reviewer = asString(asRecord(review.user)?.login);
    if (!reviewer) continue;
    // The list is chronological; a later decisive review replaces an earlier one.
    latestByReviewer.set(reviewer, { state, commit: asString(review.commit_id) });
  }
  let approved = false;
  for (const { state, commit } of latestByReviewer.values()) {
    if (commit !== headSha) continue;
    if (state === "CHANGES_REQUESTED") return "CHANGES_REQUESTED";
    if (state === "APPROVED") approved = true;
  }
  return approved ? "APPROVED" : null;
}

export interface OpenPullRequestSummary {
  number: number;
  headSha: string;
  draft: boolean;
  title: string | null;
  url: string | null;
  authorLogin: string | null;
  baseRef: string | null;
}

export interface PullRequestHeadResolver {
  /** Current state of one pull request; fetchFailed/unknown on any GitHub trouble. */
  resolve(input: { companyId: string; repository: string; number: number }): Promise<PullRequestHeadState>;
  /** Open PRs of one repo (the poll that catches PRs opened while the board was down). */
  listOpenPullRequests(input: { companyId: string; repository: string }): Promise<OpenPullRequestSummary[]>;
  /** Test helper: forget the cache. */
  resetCache(): void;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function createGitHubPrHeadResolver(input: {
  /** Required unless a custom tokenProvider replaces the secrets-service path. */
  db?: Db;
  fetch?: FetchLike;
  tokenProvider?: (companyId: string) => Promise<string | null>;
  secretNames?: readonly string[];
  ttlMs?: number;
  now?: () => Date;
  /** GitHub host the API base is derived from (github.com by default). */
  hostname?: string;
}): PullRequestHeadResolver {
  const fetchImpl: FetchLike = input.fetch ?? ghFetch;
  const secretNames = input.secretNames ?? DEFAULT_GITHUB_TOKEN_SECRET_NAMES;
  const ttlMs = input.ttlMs ?? PR_HEAD_STATE_TTL_MS;
  const now = input.now ?? (() => new Date());
  const apiBase = gitHubApiBase(input.hostname ?? "github.com");
  const tokenProvider =
    input.tokenProvider ??
    (async (companyId: string) => {
      if (!input.db) throw new Error("review routing PR resolver: no db for the token path");
      const secrets = secretService(input.db);
      for (const secretName of secretNames) {
        const secret = await secrets.getByName(companyId, secretName);
        if (!secret) continue;
        const token = await secrets.resolveSecretValue(companyId, secret.id, "latest");
        const trimmed = token?.trim();
        if (trimmed) return trimmed;
      }
      return null;
    });

  /** (company|repo|number|headSha) -> the status read for that exact head. */
  const headCache = new Map<string, { ci: "green" | "not_green"; cachedAtMs: number }>();

  function ghHeaders(token: string): Record<string, string> {
    return {
      accept: "application/vnd.github+json",
      "user-agent": "myrmidon-review-routing",
      "x-github-api-version": "2022-11-28",
      authorization: `Bearer ${token}`,
    };
  }

  async function fetchRecord(url: string, token: string): Promise<Record<string, unknown> | null> {
    const response = await fetchImpl(url, { headers: ghHeaders(token) }).catch(() => null);
    if (!response || !response.ok) return null;
    return asRecord(await response.json().catch(() => null));
  }

  /** All reviews of one PR (paginated, chronological); null on any trouble. */
  async function fetchReviews(repository: string, number: number, token: string): Promise<unknown[] | null> {
    const all: unknown[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const response = await fetchImpl(`${apiBase}/repos/${repository}/pulls/${number}/reviews?per_page=100&page=${page}`, {
        headers: ghHeaders(token),
      }).catch(() => null);
      if (!response || !response.ok) return null;
      const raw = await response.json().catch(() => null);
      if (!Array.isArray(raw)) return null;
      all.push(...raw);
      if (raw.length < 100) return all;
    }
    return all;
  }

  async function resolveToken(companyId: string): Promise<string | null> {
    try {
      const token = await tokenProvider(companyId);
      return token?.trim() || null;
    } catch {
      return null;
    }
  }

  return {
    resetCache() {
      headCache.clear();
    },

    async resolve({ companyId, repository, number }) {
      const token = await resolveToken(companyId);
      if (!token) return failedHead(repository, number);

      const pr = await fetchRecord(`${apiBase}/repos/${repository}/pulls/${number}`, token);
      if (!pr) return failedHead(repository, number);

      const open = (asString(pr.state) ?? "unknown") === "open";
      const headSha = asString(asRecord(pr.head)?.sha);
      const bodyFields: Omit<PullRequestHeadState, "ci" | "reviewDecision" | "fetchFailed"> = {
        repository,
        number,
        open,
        draft: pr.draft === true,
        headSha,
        title: asString(pr.title),
        url: asString(pr.html_url),
        authorLogin: asString(asRecord(pr.user)?.login),
        baseRef: asString(asRecord(pr.base)?.ref),
      };

      if (!open || !headSha) {
        // Closed/merged heads are left to TASK-PR-SYNC; an open PR without a
        // readable head sha is not actionable (unknown ci, never triggers).
        return { ...bodyFields, ci: "unknown", reviewDecision: null, fetchFailed: false };
      }

      // The review decision is read from the reviews list FRESH every pass
      // and filtered to the current head sha, so a verdict from an older head
      // cannot survive into this read (only the status call — head-keyed,
      // TTL-cached — is skipped on a repeat sighting of the same head).
      const reviews = await fetchReviews(repository, number, token);
      if (!reviews) return { ...bodyFields, ci: "unknown", reviewDecision: null, fetchFailed: true };
      const reviewDecision = pullRequestReviewDecisionFromReviews(reviews, headSha);
      const key = `${companyId}|${repository}|${number}|${headSha}`;
      const cached = headCache.get(key);
      if (cached && now().getTime() - cached.cachedAtMs < ttlMs) {
        return { ...bodyFields, ci: cached.ci, reviewDecision, fetchFailed: false };
      }

      const status = await fetchRecord(`${apiBase}/repos/${repository}/commits/${headSha}/status`, token);
      if (!status) {
        // The CI read failed: the head is unknown this pass. Failures are
        // never cached — the next pass retries, so an outage cannot freeze a
        // wrong verdict in for the whole TTL.
        return { ...bodyFields, ci: "unknown", reviewDecision: null, fetchFailed: true };
      }
      const ci = pullRequestCiStateFromStatusPayload(status);
      headCache.set(key, { ci, cachedAtMs: now().getTime() });
      return { ...bodyFields, ci, reviewDecision, fetchFailed: false };
    },

    async listOpenPullRequests({ companyId, repository }) {
      const token = await resolveToken(companyId);
      if (!token) return [];
      // The list endpoint answers with a bare array; anything but 2xx + array
      // reads as "no fresh data" — an outage never manufactures candidates.
      const response = await fetchImpl(`${apiBase}/repos/${repository}/pulls?state=open&per_page=100`, {
        headers: ghHeaders(token),
      }).catch(() => null);
      if (!response || !response.ok) return [];
      const raw = await response.json().catch(() => null);
      if (!Array.isArray(raw)) return [];
      const out: OpenPullRequestSummary[] = [];
      for (const entry of raw) {
        const record = asRecord(entry);
        if (!record) continue;
        const number = typeof record.number === "number" && Number.isSafeInteger(record.number) ? record.number : null;
        const headSha = asString(asRecord(record.head)?.sha);
        if (!number || !headSha) continue;
        out.push({
          number,
          headSha,
          draft: record.draft === true,
          title: asString(record.title),
          url: asString(record.html_url),
          authorLogin: asString(asRecord(record.user)?.login),
          baseRef: asString(asRecord(record.base)?.ref),
        });
      }
      return out;
    },
  };
}
