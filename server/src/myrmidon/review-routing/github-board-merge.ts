// myrmidon(OPE-11767): the GitHub half of the board-side merge — what one
// pull request looks like right now, the verdict of its required checks, and
// the merge itself.
//
// Why a client of its own. The PR-lane resolver (github.ts) reads a company
// secret named GITHUB_TOKEN / GH_TOKEN / PAPERCLIP_GITHUB_TOKEN only and the
// combined commit status; on the release board no secret has such a name, so
// that lane has never produced a task, and the combined status carries only
// `hot-files-review`, never the `CI result` check run that gates the merge.
// This client therefore (a) takes its token from the shared GitHub identity
// first — the self-hosted App serving exactly this repository, a token
// narrowed to that one repository and to contents + pull requests write
// (+ checks read) — and from the company secrets by name second, and (b) reads
// the `CI result` check runs by name (latest run per name, the cancelled /
// skipped / stale runs of superseded workflow runs are not a verdict).
//
// Cost control. Every GET is conditional (If-None-Match): a 304 does not count
// against GitHub's rate limit and replays the cached body, so a pass over
// unchanged pull requests is nearly free; nothing is requested while the
// board's global GitHub rate-limit state says the budget is gone; a failed or
// refused request is never retried inside the call. A fetch failure NEVER
// guesses: it is `ok: false` and the caller does nothing this pass.

import { and, eq, isNull } from "drizzle-orm";
import { companySecrets, type Db } from "@myrmidon/db";
import type { ReviewRoutingBoardMergeMethod } from "@myrmidon/shared";
import { DEFAULT_GITHUB_TOKEN_SECRET_NAMES } from "../../services/git-credentials.js";
import { gitHubApiBase } from "../../services/github-fetch.js";
import { isGitHubRateLimited, recordGitHubRequest } from "../../services/github-rate-limit.js";
import { secretService } from "../../services/secrets.js";
import { mintGitHubAppInstallationToken, type GitHubAppPermissions } from "../github-shared-identity/app-token.js";
import { isRepositoryAllowed, normalizeGitHubRepository } from "../github-shared-identity/settings.js";
import { readGitHubSharedIdentitySettings } from "../github-shared-identity/store.js";
import type { BoardMergeFacts, RequiredCheckVerdict } from "./pr-policy.js";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type BoardMergePullResult = { ok: true; facts: BoardMergeFacts } | { ok: false; reason: string };
export type BoardMergeChecksResult =
  | { ok: true; checks: Record<string, RequiredCheckVerdict> }
  | { ok: false; reason: string };

export type BoardMergeOutcome =
  /** GitHub merged the head (`sha` is the merge commit). */
  | { status: "merged"; sha: string | null }
  /** The head moved since it was read: GitHub refused to merge a different commit (409). */
  | { status: "head_moved" }
  /** GitHub says the PR is not mergeable as it stands (405 / 422): required checks, protection, method. */
  | { status: "refused"; httpStatus: number }
  /** No token, network, auth or rate limit: nothing happened. */
  | { status: "failed"; reason: string };

export interface BoardMergeClient {
  readPull(input: { companyId: string; repository: string; number: number }): Promise<BoardMergePullResult>;
  readChecks(input: {
    companyId: string;
    repository: string;
    headSha: string;
    names: readonly string[];
  }): Promise<BoardMergeChecksResult>;
  /** Puts the review marker on the PR; true when GitHub accepted it. */
  addApprovedLabel(input: { companyId: string; repository: string; number: number; label: string }): Promise<boolean>;
  merge(input: {
    companyId: string;
    repository: string;
    number: number;
    headSha: string;
    method: ReviewRoutingBoardMergeMethod;
  }): Promise<BoardMergeOutcome>;
}

const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 30_000;
const ETAG_CACHE_MAX_ENTRIES = 300;
/** An installation token lives an hour; the client reuses what it resolved for ten minutes (a 401 drops it at once). */
const TOKEN_REUSE_MS = 10 * 60 * 1000;
const CONSUMER_ID = "review-routing-board-merge";

/** Conclusions of a completed run that are not a verdict on the head (superseded / label-only runs). */
const NOT_A_VERDICT_CONCLUSIONS: ReadonlySet<string> = new Set(["cancelled", "skipped", "stale"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** The pull request facts the decision reads, off a `GET /pulls/{n}` payload. */
export function boardMergeFactsFromPullPayload(pr: Record<string, unknown>): BoardMergeFacts {
  const rawLabels = Array.isArray(pr.labels) ? pr.labels : [];
  const labels = rawLabels
    .map((item: unknown) => (typeof item === "string" ? item : asString(asRecord(item)?.name)))
    .filter((label): label is string => Boolean(label));
  return {
    open: asString(pr.state) === "open" && pr.merged !== true,
    draft: pr.draft === true,
    headSha: asString(asRecord(pr.head)?.sha),
    baseRef: asString(asRecord(pr.base)?.ref),
    mergeable: typeof pr.mergeable === "boolean" ? pr.mergeable : null,
    mergeableState: asString(pr.mergeable_state),
    labels,
  };
}

/**
 * The verdict of one required check from ITS check runs: the latest run that
 * is a verdict decides. Runs are walked newest first (check run ids only
 * grow); a completed cancelled / skipped / stale run is a superseded one and
 * is passed over, so the queued or running rerun that replaced it is seen as
 * pending and a successful rerun wins over the failure before it. No run at
 * all is pending: the check has not started.
 */
export function requiredCheckVerdict(runs: readonly unknown[], name: string): RequiredCheckVerdict {
  const named = runs
    .map(asRecord)
    .filter((run): run is Record<string, unknown> => run !== null && run.name === name)
    .sort((left, right) => Number(right.id ?? 0) - Number(left.id ?? 0));
  for (const run of named) {
    if (run.status !== "completed") return "pending";
    const conclusion = asString(run.conclusion);
    if (conclusion !== null && NOT_A_VERDICT_CONCLUSIONS.has(conclusion)) continue;
    return conclusion === "success" ? "success" : "failed";
  }
  return "pending";
}

/**
 * The write token of one repository: the shared GitHub identity App that
 * serves exactly this repository (two Apps — ambiguous, never a silent pick),
 * narrowed to contents + pull requests write (+ checks read when the entry has
 * it); otherwise a company secret by name. null when nothing serves the repo.
 */
export async function resolveBoardMergeToken(input: {
  db: Db;
  companyId: string;
  repository: string;
  secretNames?: readonly string[];
  fetch?: FetchLike;
}): Promise<string | null> {
  const repository = normalizeGitHubRepository(input.repository);
  if (!repository) return null;
  const secrets = secretService(input.db);
  const accessContext = {
    consumerType: "system" as const,
    consumerId: CONSUMER_ID,
    configPath: `github_merge:${repository}`,
    actorType: "system" as const,
  };

  const settings = await readGitHubSharedIdentitySettings(input.db, input.companyId);
  if (settings.enabled) {
    const apps = settings.apps.filter((entry) => isRepositoryAllowed(entry.allowedRepos, repository));
    if (apps.length > 1) return null;
    const app = apps[0];
    if (app) {
      // The operator's permission list is the ceiling: an entry that does not
      // grant write on contents and pull requests cannot merge.
      if (app.permissions.contents !== "write" || app.permissions.pull_requests !== "write") return null;
      const [keySecret] = await input.db
        .select({ id: companySecrets.id })
        .from(companySecrets)
        .where(
          and(
            eq(companySecrets.id, app.privateKeySecretId),
            eq(companySecrets.companyId, input.companyId),
            eq(companySecrets.scope, "company"),
            eq(companySecrets.status, "active"),
            isNull(companySecrets.deletedAt),
          ),
        );
      if (!keySecret) return null;
      try {
        const permissions: Partial<GitHubAppPermissions> = { contents: "write", pull_requests: "write" };
        if (app.permissions.checks !== "none") permissions.checks = "read";
        const privateKeyPem = await secrets.resolveSecretValue(input.companyId, keySecret.id, "latest", { accessContext });
        const minted = await mintGitHubAppInstallationToken({
          appId: app.appId,
          privateKeyPem,
          installationId: app.installationId,
          repository,
          permissions,
          fetchImpl: input.fetch as typeof fetch | undefined,
        });
        return minted.token;
      } catch {
        return null;
      }
    }
  }

  for (const secretName of input.secretNames ?? DEFAULT_GITHUB_TOKEN_SECRET_NAMES) {
    const secret = await secrets.getByName(input.companyId, secretName);
    if (!secret) continue;
    const value = await secrets.resolveSecretValue(input.companyId, secret.id, "latest", { accessContext });
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export function createGitHubBoardMergeClient(input: {
  /** Required unless a custom tokenProvider replaces the shared-identity path. */
  db?: Db;
  fetch?: FetchLike;
  tokenProvider?: (companyId: string, repository: string) => Promise<string | null>;
  hostname?: string;
}): BoardMergeClient {
  const fetchImpl: FetchLike = input.fetch ?? ((url, init) => fetch(url, init));
  const apiBase = gitHubApiBase(input.hostname ?? "github.com");
  const tokenProvider =
    input.tokenProvider ??
    (async (companyId: string, repository: string) => {
      if (!input.db) throw new Error("board merge client: no db for the token path");
      return resolveBoardMergeToken({ db: input.db, companyId, repository, fetch: input.fetch });
    });

  /** url -> the last 200 body and its ETag, for If-None-Match; bounded, oldest out first. */
  const etagCache = new Map<string, { etag: string; body: unknown }>();

  /** (company|repository) -> the token resolved last, so a pass does not resolve the key secret for every request. */
  const tokenCache = new Map<string, { token: string; untilMs: number }>();

  async function token(companyId: string, repository: string): Promise<string | null> {
    const key = `${companyId}|${repository.toLowerCase()}`;
    const cached = tokenCache.get(key);
    if (cached && cached.untilMs > Date.now()) return cached.token;
    try {
      const resolved = (await tokenProvider(companyId, repository))?.trim() || null;
      if (resolved) tokenCache.set(key, { token: resolved, untilMs: Date.now() + TOKEN_REUSE_MS });
      else tokenCache.delete(key);
      return resolved;
    } catch {
      tokenCache.delete(key);
      return null;
    }
  }

  /** GitHub refused the credential: the next request resolves a fresh one. */
  function forgetToken(companyId: string, repository: string): void {
    tokenCache.delete(`${companyId}|${repository.toLowerCase()}`);
  }

  function headers(accessToken: string, extra: Record<string, string> = {}): Record<string, string> {
    return {
      accept: "application/vnd.github+json",
      "user-agent": "myrmidon-review-routing-board-merge",
      "x-github-api-version": "2022-11-28",
      authorization: `Bearer ${accessToken}`,
      ...extra,
    };
  }

  /** A conditional GET: 304 replays the cached body without spending rate limit. */
  async function getJson(
    url: string,
    accessToken: string,
    onUnauthorized: () => void,
  ): Promise<{ ok: true; json: unknown } | { ok: false; reason: string }> {
    const cached = etagCache.get(url);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: headers(accessToken, cached ? { "if-none-match": cached.etag } : {}),
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, reason: "network_error" };
    }
    recordGitHubRequest("board-merge", response);
    if (response.status === 304 && cached) return { ok: true, json: cached.body };
    if (response.status === 401) onUnauthorized();
    if (!response.ok) return { ok: false, reason: `http_${response.status}` };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, reason: "unreadable_payload" };
    }
    const etag = response.headers.get("etag");
    if (etag) {
      etagCache.delete(url);
      while (etagCache.size >= ETAG_CACHE_MAX_ENTRIES) {
        const oldest = etagCache.keys().next().value;
        if (oldest === undefined) break;
        etagCache.delete(oldest);
      }
      etagCache.set(url, { etag, body });
    }
    return { ok: true, json: body };
  }

  return {
    async readPull({ companyId, repository, number }) {
      if (isGitHubRateLimited()) return { ok: false, reason: "rate_limited" };
      const accessToken = await token(companyId, repository);
      if (!accessToken) return { ok: false, reason: "no_token" };
      const read = await getJson(`${apiBase}/repos/${repository}/pulls/${number}`, accessToken, () => forgetToken(companyId, repository));
      if (!read.ok) return read;
      const pr = asRecord(read.json);
      if (!pr) return { ok: false, reason: "unreadable_payload" };
      return { ok: true, facts: boardMergeFactsFromPullPayload(pr) };
    },

    async readChecks({ companyId, repository, headSha, names }) {
      if (isGitHubRateLimited()) return { ok: false, reason: "rate_limited" };
      const accessToken = await token(companyId, repository);
      if (!accessToken) return { ok: false, reason: "no_token" };
      const checks: Record<string, RequiredCheckVerdict> = {};
      for (const name of names) {
        // `filter=all` keeps the runs of earlier, superseded workflow runs of
        // the same head; `filter=latest` would hide a queued rerun behind the
        // cancelled run it replaced.
        const read = await getJson(
          `${apiBase}/repos/${repository}/commits/${encodeURIComponent(headSha)}/check-runs` +
            `?check_name=${encodeURIComponent(name)}&filter=all&per_page=100`,
          accessToken,
          () => forgetToken(companyId, repository),
        );
        if (!read.ok) return read;
        const runs = asRecord(read.json)?.check_runs;
        if (!Array.isArray(runs)) return { ok: false, reason: "unreadable_payload" };
        checks[name] = requiredCheckVerdict(runs, name);
      }
      return { ok: true, checks };
    },

    async addApprovedLabel({ companyId, repository, number, label }) {
      if (isGitHubRateLimited()) return false;
      const accessToken = await token(companyId, repository);
      if (!accessToken) return false;
      try {
        const response = await fetchImpl(`${apiBase}/repos/${repository}/issues/${number}/labels`, {
          method: "POST",
          headers: headers(accessToken, { "content-type": "application/json" }),
          body: JSON.stringify({ labels: [label] }),
          signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
        });
        recordGitHubRequest("board-merge", response);
        if (response.status === 401) forgetToken(companyId, repository);
        return response.ok;
      } catch {
        return false;
      }
    },

    async merge({ companyId, repository, number, headSha, method }) {
      if (isGitHubRateLimited()) return { status: "failed", reason: "rate_limited" };
      const accessToken = await token(companyId, repository);
      if (!accessToken) return { status: "failed", reason: "no_token" };
      let response: Response;
      try {
        // `sha` pins the merge to the approved head: GitHub answers 409 when
        // the head moved, so a commit nobody reviewed can never be merged.
        response = await fetchImpl(`${apiBase}/repos/${repository}/pulls/${number}/merge`, {
          method: "PUT",
          headers: headers(accessToken, { "content-type": "application/json" }),
          body: JSON.stringify({ sha: headSha, merge_method: method }),
          signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
        });
      } catch {
        return { status: "failed", reason: "network_error" };
      }
      recordGitHubRequest("board-merge", response);
      if (response.status === 401) forgetToken(companyId, repository);
      if (response.ok) {
        const body = asRecord(await response.json().catch(() => null));
        if (body && body.merged === false) return { status: "refused", httpStatus: response.status };
        return { status: "merged", sha: asString(body?.sha) };
      }
      if (response.status === 409) return { status: "head_moved" };
      if (response.status === 405 || response.status === 422) return { status: "refused", httpStatus: response.status };
      return { status: "failed", reason: `http_${response.status}` };
    },
  };
}
