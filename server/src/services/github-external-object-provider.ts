import { and, eq, isNull } from "drizzle-orm";
import { companySecrets, type Db } from "@myrmidon/db";
import type { ExternalObjectCanonicalUrl } from "@myrmidon/shared";
import { DEFAULT_GITHUB_TOKEN_SECRET_NAMES } from "./git-credentials.js";
export { DEFAULT_GITHUB_TOKEN_SECRET_NAMES } from "./git-credentials.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import { getGitHubRateLimitResetEpochSeconds, isGitHubRateLimited, recordGitHubRequest, type GitHubRequestSource } from "./github-rate-limit.js";
import { secretService } from "./secrets.js";
import { readGitHubSharedIdentitySettings } from "../myrmidon/github-shared-identity/store.js";
import { isRepositoryAllowed, normalizeGitHubRepository } from "../myrmidon/github-shared-identity/settings.js";
import { mintGitHubAppInstallationToken, type GitHubAppPermissions } from "../myrmidon/github-shared-identity/app-token.js";
import type {
  ExternalObjectDetection,
  ExternalObjectDetector,
  ExternalObjectResolver,
  ExternalObjectResolverSnapshot,
  ExternalObjectResolveResult,
} from "./external-objects.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GitHubExternalObjectProviderOptions {
  fetch?: FetchLike;
  tokenProvider?: ((companyId: string, repository: string) => Promise<string | null> | string | null) | string | null;
  secretNames?: readonly string[];
  /**
   * myrmidon(OPE-12397): the rate-limit accounting bucket this provider's
   * GitHub reads count into. Every reader passes its own (`review-rework`,
   * `run-context`, `ui-refresh`, `task-pr-sync`, `board-merge`, …) so the
   * `[github-rate-limit]` log attributes the spend; the historical default
   * keeps the pre-OPE-12397 behavior unchanged for callers that do not care.
   */
  source?: GitHubRequestSource;
}

interface GitHubObjectIdentity {
  host: string;
  owner: string;
  repo: string;
  number: number;
  objectType: "pull_request" | "issue";
  pathKind: "pull" | "issues";
}

const GITHUB_OBJECT_TTL_SECONDS = 300;

function isGitHubHost(host: string) {
  const h = host.toLowerCase();
  return h === "github.com" || h === "www.github.com";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function asBoolean(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function asNonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function asNestedString(record: Record<string, unknown>, key: string, nestedKey: string) {
  const nested = asRecord(record[key]);
  return nested ? asString(nested[nestedKey]) : null;
}

function parseGitHubCanonicalUrl(canonical: ExternalObjectCanonicalUrl): GitHubObjectIdentity | null {
  if (canonical.canonicalIdentity.scheme !== "https") return null;
  const host = canonical.canonicalIdentity.host.toLowerCase();
  if (!isGitHubHost(host)) return null;

  const parts = canonical.canonicalIdentity.path.split("/").filter(Boolean);
  if (parts.length !== 4) return null;
  const [owner, repo, kind, rawNumber] = parts;
  if (!owner || !repo || !kind || !rawNumber) return null;
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
  if (!/^[1-9][0-9]*$/.test(rawNumber)) return null;
  if (kind !== "pull" && kind !== "issues") return null;

  return {
    host: host === "www.github.com" ? "github.com" : host,
    owner,
    repo,
    number: Number(rawNumber),
    pathKind: kind,
    objectType: kind === "pull" ? "pull_request" : "issue",
  };
}

function parseGitHubObject(object: { externalId: string; sanitizedCanonicalUrl: string | null }): GitHubObjectIdentity | null {
  const match = /^([^/]+)\/([^/]+)#(pull|issues)\/([1-9][0-9]*)$/.exec(object.externalId);
  if (!match) return null;
  let host = "github.com";
  if (object.sanitizedCanonicalUrl) {
    try {
      const url = new URL(object.sanitizedCanonicalUrl);
      if (isGitHubHost(url.hostname)) host = url.hostname === "www.github.com" ? "github.com" : url.hostname;
    } catch {
      return null;
    }
  }
  return {
    host,
    owner: match[1]!,
    repo: match[2]!,
    pathKind: match[3] as "pull" | "issues",
    number: Number(match[4]),
    objectType: match[3] === "pull" ? "pull_request" : "issue",
  };
}

function externalIdFor(identity: GitHubObjectIdentity) {
  return `${identity.owner.toLowerCase()}/${identity.repo.toLowerCase()}#${identity.pathKind}/${identity.number}`;
}

function displayTitleFor(identity: GitHubObjectIdentity) {
  return `${identity.owner}/${identity.repo}#${identity.number}`;
}

function displayKeyFor(identity: Pick<GitHubObjectIdentity, "objectType">) {
  return identity.objectType === "pull_request" ? "GitHub Pull Request" : "GitHub Issue";
}

function retryAfterSeconds(response: Response) {
  const retryAfter = response.headers?.get ? response.headers.get("retry-after") : null;
  if (retryAfter && /^[0-9]+$/.test(retryAfter)) return Number(retryAfter);

  const reset = response.headers?.get ? response.headers.get("x-ratelimit-reset") : null;
  if (reset && /^[0-9]+$/.test(reset)) {
    return Math.max(1, Number(reset) - Math.floor(Date.now() / 1000));
  }

  return 300;
}

function failureFromGitHubResponse(response: Response): ExternalObjectResolveResult | null {
  if (response.status === 401) {
    return {
      ok: false,
      liveness: "auth_required",
      errorCode: "github_auth_required",
      errorMessage: "GitHub authentication is required to refresh this object.",
      retryAfterSeconds: retryAfterSeconds(response),
    };
  }

  if (response.status === 403) {
    const rateLimitRemaining = response.headers?.get ? response.headers.get("x-ratelimit-remaining") : null;
    if (rateLimitRemaining === "0") {
      return {
        ok: false,
        liveness: "unreachable",
        errorCode: "github_rate_limited",
        errorMessage: "GitHub rate limit reached while refreshing this object.",
        retryAfterSeconds: retryAfterSeconds(response),
      };
    }
    return {
      ok: false,
      liveness: "auth_required",
      errorCode: "github_forbidden",
      errorMessage: "GitHub rejected the configured credentials for this object.",
      retryAfterSeconds: retryAfterSeconds(response),
    };
  }

  if (response.status === 429 || response.status >= 500) {
    return {
      ok: false,
      liveness: "unreachable",
      errorCode: response.status === 429 ? "github_rate_limited" : "github_unreachable",
      errorMessage: `GitHub returned HTTP ${response.status} while refreshing this object.`,
      retryAfterSeconds: retryAfterSeconds(response),
    };
  }

  return null;
}

function notFoundSnapshot(identity: GitHubObjectIdentity, etag: string | null, authenticated: boolean): ExternalObjectResolverSnapshot {
  return {
    displayKey: displayKeyFor(identity),
    iconKey: "github",
    displayTitle: displayTitleFor(identity),
    statusKey: "not_found",
    statusLabel: "Not found",
    statusIconKey: "archive",
    statusCategory: "archived",
    statusTone: "muted",
    isTerminal: true,
    etag,
    ttlSeconds: GITHUB_OBJECT_TTL_SECONDS,
    data: {
      provider: "github",
      owner: identity.owner,
      repo: identity.repo,
      number: identity.number,
      notFound: true,
      // GitHub answers 404 for a private repository the caller cannot read:
      // "not found" is not proof the PR does not exist.
      authenticated,
    },
  };
}

function pullRequestSnapshot(
  identity: GitHubObjectIdentity,
  body: Record<string, unknown>,
  etag: string | null,
  extra?: { mergeCommitReachable?: boolean },
): ExternalObjectResolverSnapshot {
  const title = asString(body.title);
  const state = asString(body.state) ?? "unknown";
  const draft = asBoolean(body.draft) ?? false;
  const merged = (asBoolean(body.merged) ?? false) || Boolean(asString(body.merged_at));
  const authorLogin = asNestedString(body, "user", "login");
  const headRef = asNestedString(body, "head", "ref");
  const headSha = asNestedString(body, "head", "sha");
  const baseRef = asNestedString(body, "base", "ref");
  const baseRepo = asRecord(asRecord(body.base)?.repo);
  const defaultBranch = asString(baseRepo?.default_branch) ?? "main";
  const reviewDecision = asString(body.review_decision);
  const rawMergeable = body.mergeable ?? body.mergeable_state ?? body.mergeableState;
  const mergeable = rawMergeable === "CONFLICTING" || rawMergeable === false || rawMergeable === "dirty"
    ? "CONFLICTING"
    : rawMergeable === "MERGEABLE" || rawMergeable === true || rawMergeable === "clean"
      ? "MERGEABLE"
      : asString(rawMergeable);
  const additions = asNonNegativeInteger(body.additions);
  const deletions = asNonNegativeInteger(body.deletions);
  const changedFiles = asNonNegativeInteger(body.changed_files);
  const mergeCommitSha = asString(body.merge_commit_sha);
  const mergeCommitReachable = extra?.mergeCommitReachable !== undefined
    ? extra.mergeCommitReachable
    : merged
      ? (!baseRef || baseRef === defaultBranch || baseRef.startsWith("rel/"))
      : undefined;

  let statusKey = state;
  let statusLabel = state === "open" ? "Open" : state === "closed" ? "Closed" : "Unknown";
  let statusCategory: ExternalObjectResolverSnapshot["statusCategory"] = state === "open" ? "open" : "unknown";
  let statusTone: ExternalObjectResolverSnapshot["statusTone"] = state === "open" ? "info" : "neutral";
  let isTerminal = false;

  if (merged) {
    statusKey = "merged";
    statusLabel = "Merged";
    statusCategory = "succeeded";
    statusTone = "success";
    isTerminal = true;
  } else if (state === "closed") {
    statusKey = "closed";
    statusLabel = "Closed";
    statusCategory = "closed";
    statusTone = "muted";
    isTerminal = true;
  } else if (draft) {
    statusKey = "draft";
    statusLabel = "Draft";
    statusCategory = "waiting";
    statusTone = "warning";
  }

  return {
    displayKey: displayKeyFor(identity),
    iconKey: "github",
    displayTitle: title ? `${displayTitleFor(identity)}: ${title}` : displayTitleFor(identity),
    statusKey,
    statusLabel,
    statusIconKey: merged
      ? "git-merge"
      : state === "closed"
      ? "x-circle"
      : draft
      ? "clock"
      : "git-pull-request",
    statusCategory,
    statusTone,
    isTerminal,
    remoteVersion: asString(body.updated_at),
    etag,
    ttlSeconds: GITHUB_OBJECT_TTL_SECONDS,
    data: {
      provider: "github",
      owner: identity.owner,
      repo: identity.repo,
      number: identity.number,
      state,
      merged,
      draft,
      ...(mergeable ? { mergeable } : {}),
      ...(authorLogin ? { authorLogin } : {}),
      ...(headRef ? { headRef } : {}),
      ...(headSha ? { headSha } : {}),
      ...(baseRef ? { baseRef } : {}),
      ...(defaultBranch ? { defaultBranch } : {}),
      ...(reviewDecision ? { reviewDecision } : {}),
      ...(additions !== null ? { additions } : {}),
      ...(deletions !== null ? { deletions } : {}),
      ...(changedFiles !== null ? { changedFiles } : {}),
      ...(mergeCommitSha ? { mergeCommitSha } : {}),
      ...(mergeCommitReachable !== undefined ? { mergeCommitReachable } : {}),
    },
  };
}

function issueSnapshot(identity: GitHubObjectIdentity, body: Record<string, unknown>, etag: string | null): ExternalObjectResolverSnapshot {
  const title = asString(body.title);
  const state = asString(body.state) ?? "unknown";
  const stateReason = asString(body.state_reason);
  const authorLogin = asNestedString(body, "user", "login");
  const statusKey = state === "closed" && stateReason ? `closed_${stateReason}` : state;
  const statusLabel = state === "closed"
    ? stateReason
      ? `Closed: ${stateReason.replace(/_/g, " ")}`
      : "Closed"
    : state === "open"
    ? "Open"
    : "Unknown";

  return {
    displayKey: displayKeyFor(identity),
    iconKey: "github",
    displayTitle: title ? `${displayTitleFor(identity)}: ${title}` : displayTitleFor(identity),
    statusKey,
    statusLabel,
    statusIconKey: state === "closed" ? "circle" : "circle-dot",
    statusCategory: state === "open" ? "open" : state === "closed" ? "closed" : "unknown",
    statusTone: state === "open" ? "info" : state === "closed" ? "muted" : "neutral",
    isTerminal: state === "closed",
    remoteVersion: asString(body.updated_at),
    etag,
    ttlSeconds: GITHUB_OBJECT_TTL_SECONDS,
    data: {
      provider: "github",
      owner: identity.owner,
      repo: identity.repo,
      number: identity.number,
      state,
      ...(stateReason ? { stateReason } : {}),
      ...(authorLogin ? { authorLogin } : {}),
    },
  };
}

async function safeJson(response: Response) {
  try {
    return asRecord(await response.json());
  } catch {
    return null;
  }
}

/** Audit identity of the resolver's secret reads (system consumer, no agent/run). */
const RESOLVER_CONSUMER_ID = "github-external-object-resolver";

/**
 * The resolver reads PR/issue state only: a read-only, single-repository token.
 * `checks: read`: the review-stage recovery reads the check runs of the PR head
 * with this token (review-stage-recovery/github-ci.ts). Without it GitHub answers
 * 403, the read falls back to anonymous, and the anonymous per-IP limit runs out,
 * so a reviewer that waits for CI is blocked as a stalled review (OPE-10246).
 */
export const READ_ONLY_APP_PERMISSIONS = {
  contents: "read",
  pull_requests: "read",
  checks: "read",
  issues: "none",
  actions: "none",
  deployments: "none",
  environments: "none",
  workflows: "none",
} as const;

export const JOB_LOG_APP_PERMISSIONS = {
  ...READ_ONLY_APP_PERMISSIONS,
  actions: "read",
} as const;

export type GitHubRepositoryTokenOptions = {
  permissions?: Partial<GitHubAppPermissions>;
};

/**
 * Token for reading one repository, in order:
 *   1. a company secret by name (GITHUB_TOKEN, ...);
 *   2. the shared GitHub identity: exactly one company App that allows the
 *      repository -> a read-only installation token for that repository;
 *      two or more Apps -> throws (fail closed, never a silent pick);
 *   3. null (anonymous), as before.
 * Neither a token nor an App key is logged or returned in an error.
 */
export async function resolveGitHubRepositoryToken(
  db: Db,
  companyId: string,
  repository: string,
  secretNames?: readonly string[],
  fetchImpl?: FetchLike,
  options?: GitHubRepositoryTokenOptions,
): Promise<string | null>;
export async function resolveGitHubRepositoryToken(
  db: Db,
  companyId: string,
  repository: string,
  options?: GitHubRepositoryTokenOptions,
): Promise<string | null>;
export async function resolveGitHubRepositoryToken(
  db: Db,
  companyId: string,
  repository: string,
  secretNamesOrOptions?: readonly string[] | GitHubRepositoryTokenOptions,
  fetchImpl?: FetchLike,
  options?: GitHubRepositoryTokenOptions,
): Promise<string | null> {
  let secretNames: readonly string[] = DEFAULT_GITHUB_TOKEN_SECRET_NAMES;
  let resolvedOptions = options;
  if (Array.isArray(secretNamesOrOptions)) {
    secretNames = secretNamesOrOptions;
  } else if (secretNamesOrOptions && typeof secretNamesOrOptions === "object") {
    resolvedOptions = secretNamesOrOptions as GitHubRepositoryTokenOptions;
  }
  return defaultTokenProvider(db, companyId, repository, secretNames, fetchImpl, resolvedOptions);
}

export async function defaultTokenProvider(
  db: Db,
  companyId: string,
  repository: string,
  secretNames: readonly string[],
  fetchImpl?: FetchLike,
  options?: GitHubRepositoryTokenOptions,
) {
  const secrets = secretService(db);
  const accessContext = {
    consumerType: "system" as const,
    consumerId: RESOLVER_CONSUMER_ID,
    configPath: `github_token:${repository}`,
    actorType: "system" as const,
  };
  for (const secretName of secretNames) {
    const secret = await secrets.getByName(companyId, secretName);
    if (!secret) continue;
    const token = await secrets.resolveSecretValue(companyId, secret.id, "latest", { accessContext });
    const trimmed = token.trim();
    if (trimmed) return trimmed;
  }

  const normalized = normalizeGitHubRepository(repository);
  if (!normalized) return null;
  const settings = await readGitHubSharedIdentitySettings(db, companyId);
  if (!settings.enabled) return null;
  const apps = settings.apps.filter((entry) => isRepositoryAllowed(entry.allowedRepos, normalized));
  if (apps.length > 1) throw new Error("Several GitHub Apps allow this repository");
  if (apps.length === 1) {
    const app = apps[0]!;
    const [keySecret] = await db
      .select({ id: companySecrets.id })
      .from(companySecrets)
      .where(and(
        eq(companySecrets.id, app.privateKeySecretId),
        eq(companySecrets.companyId, companyId),
        eq(companySecrets.scope, "company"),
        eq(companySecrets.status, "active"),
        isNull(companySecrets.deletedAt),
      ));
    if (!keySecret) return null;
    try {
      const getPrivateKeyPem = () =>
        secrets.resolveSecretValue(companyId, keySecret.id, "latest", {
          accessContext: { ...accessContext, configPath: `github_app:${normalized}` },
        });
      const minted = await mintGitHubAppInstallationToken({
        appId: app.appId,
        privateKeyPem: getPrivateKeyPem,
        installationId: app.installationId,
        repository: normalized,
        permissions: options?.permissions ?? READ_ONLY_APP_PERMISSIONS,
        fetchImpl: fetchImpl as typeof fetch | undefined,
      });
      return minted.token;
    } catch {
      return null;
    }
  }

  const pats = settings.pats.filter((entry) => isRepositoryAllowed(entry.allowedRepos, normalized));
  if (pats.length > 1) throw new Error("Several GitHub PATs allow this repository");
  if (pats.length === 1) {
    const pat = pats[0]!;
    const [tokenSecret] = await db
      .select({ id: companySecrets.id })
      .from(companySecrets)
      .where(and(
        eq(companySecrets.id, pat.tokenSecretId),
        eq(companySecrets.companyId, companyId),
        eq(companySecrets.scope, "company"),
        eq(companySecrets.status, "active"),
        isNull(companySecrets.deletedAt),
      ));
    if (!tokenSecret) return null;
    try {
      const token = await secrets.resolveSecretValue(companyId, tokenSecret.id, "latest", {
        accessContext: { ...accessContext, configPath: `github_pat:${normalized}` },
      });
      return token.trim() || null;
    } catch {
      return null;
    }
  }
  return null;
}

// myrmidon(OPE-12397): the provider's read cache, one per process. Every caller (review
// rework, merge details, CI resolver, work-products refresh) passes an object without an etag,
// so each of its reads was a full GET 200: ~94 open pull requests cost 4-5k requests an hour
// and used up the App's 5000/h budget, after which the CI gate of the review went blind.
// An object is served from memory for MYRMIDON_GITHUB_OBJECT_CACHE_TTL_SEC (0 = cache off) and
// a merged / closed / not found one for MYRMIDON_GITHUB_OBJECT_TERMINAL_TTL_SEC; after that the
// read is conditional (If-None-Match; a 304 costs no rate limit), reads of one object that run
// in parallel share one request, and nothing is asked while the shared rate-limit state says
// the budget is gone (the cached result, even an expired one, is returned instead).
const GITHUB_OBJECT_CACHE_TTL_ENV = "MYRMIDON_GITHUB_OBJECT_CACHE_TTL_SEC";
const GITHUB_OBJECT_TERMINAL_TTL_ENV = "MYRMIDON_GITHUB_OBJECT_TERMINAL_TTL_SEC";
const DEFAULT_GITHUB_OBJECT_CACHE_TTL_SECONDS = 120;
const DEFAULT_GITHUB_OBJECT_TERMINAL_TTL_SECONDS = 1800;
export const GITHUB_OBJECT_CACHE_MAX_ENTRIES = 5000;

interface CachedGitHubObject {
  etag: string | null;
  result: ExternalObjectResolveResult;
  fetchedAt: number;
  terminal: boolean;
}

/** key -> the last good read; insertion order is age order, the oldest goes first. */
const objectCache = new Map<string, CachedGitHubObject>();
/** key -> the read that is on the wire now. */
const objectReads = new Map<string, Promise<ExternalObjectResolveResult>>();
/** Bumped on every invalidation: a read that started before it must not be stored. */
let objectCacheEpoch = 0;

function readTtlSeconds(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  return raw && /^\d+$/.test(raw) ? Number(raw) : fallback;
}

function objectCacheTail(repository: string, pathKind: GitHubObjectIdentity["pathKind"], number: number) {
  return `${repository.toLowerCase()}|${pathKind}|${number}`;
}

// The answer depends on the token only through the company that owns it, so the company is in
// the key: one company's private-repository read is never served to another.
function objectCacheKey(companyId: string, identity: GitHubObjectIdentity) {
  return `${companyId}|${identity.host}|${objectCacheTail(`${identity.owner}/${identity.repo}`, identity.pathKind, identity.number)}`;
}

/**
 * Forgets the cached read of one pull request (every company and host), also the read that is
 * on the wire now: call it when the board itself changed the PR, e.g. merged it.
 */
export function invalidateGitHubPullRequestCache(repository: string, number: number) {
  objectCacheEpoch += 1;
  const tail = `|${objectCacheTail(repository, "pull", number)}`;
  for (const key of objectCache.keys()) {
    if (key.endsWith(tail)) objectCache.delete(key);
  }
  for (const key of objectReads.keys()) {
    if (key.endsWith(tail)) objectReads.delete(key);
  }
}

export function resetGitHubObjectCacheForTests() {
  objectCacheEpoch += 1;
  objectCache.clear();
  objectReads.clear();
}

function rememberGitHubObject(key: string, result: ExternalObjectResolveResult) {
  if (!result.ok) return;
  const { snapshot } = result;
  const data = asRecord(snapshot.data);
  // Not final whatever the state says: a merged PR whose merge commit the default branch does
  // not reach yet (the /compare verdict can still flip, and a 304 would replay it), and a
  // "not found" that an anonymous read got (a missing token, not a missing PR).
  const reachabilityOpen = data?.mergeCommitReachable === false;
  const anonymousNotFound = data?.notFound === true && data?.authenticated === false;
  objectCache.delete(key);
  while (objectCache.size >= GITHUB_OBJECT_CACHE_MAX_ENTRIES) {
    const oldest = objectCache.keys().next().value;
    if (oldest === undefined) break;
    objectCache.delete(oldest);
  }
  objectCache.set(key, {
    etag: reachabilityOpen ? null : snapshot.etag ?? null,
    result,
    fetchedAt: Date.now(),
    terminal: snapshot.isTerminal === true && !reachabilityOpen && !anonymousNotFound,
  });
}

/** The answer GitHub's own 403 "rate limit" gets above, for a read that was not sent at all. */
function rateLimitedResult(): ExternalObjectResolveResult {
  const resetAt = getGitHubRateLimitResetEpochSeconds();
  return {
    ok: false,
    liveness: "unreachable",
    errorCode: "github_rate_limited",
    errorMessage: "GitHub rate limit reached while refreshing this object.",
    retryAfterSeconds: resetAt ? Math.max(1, resetAt - Math.floor(Date.now() / 1000)) : GITHUB_OBJECT_TTL_SECONDS,
  };
}

export function createGitHubExternalObjectProvider(
  db: Db,
  opts: GitHubExternalObjectProviderOptions = {},
): { detector: ExternalObjectDetector; resolvers: ExternalObjectResolver[] } {
  const fetchImpl = opts.fetch ?? ghFetch;
  const secretNames = opts.secretNames ?? DEFAULT_GITHUB_TOKEN_SECRET_NAMES;
  const tokenProvider = Object.prototype.hasOwnProperty.call(opts, "tokenProvider") && opts.tokenProvider !== undefined
    ? opts.tokenProvider
    : ((companyId: string, repository: string) => defaultTokenProvider(db, companyId, repository, secretNames, opts.fetch));

  const detector: ExternalObjectDetector = {
    key: "github",
    detect({ urls }): ExternalObjectDetection[] {
      return urls.flatMap((canonical) => {
        const identity = parseGitHubCanonicalUrl(canonical);
        if (!identity) return [];
        return [{
          canonical,
          detectorKey: "github",
          providerKey: "github",
          objectType: identity.objectType,
          externalId: externalIdFor(identity),
          displayKey: displayKeyFor(identity),
          iconKey: "github",
          displayTitle: displayTitleFor(identity),
          confidence: "exact",
        }];
      });
    },
  };

  function resolver(objectType: GitHubObjectIdentity["objectType"]): ExternalObjectResolver {
    // myrmidon(OPE-12397): the read itself, as before; `resolve` further down puts the cache in front of it.
    const network = {
      async resolve({ companyId, object, cached }: Parameters<ExternalObjectResolver["resolve"]>[0] & { cached?: CachedGitHubObject }): Promise<ExternalObjectResolveResult> {
        const identity = parseGitHubObject(object);
        if (!identity || identity.objectType !== objectType) {
          return {
            ok: false,
            liveness: "unreachable",
            errorCode: "github_invalid_identity",
            errorMessage: "GitHub object identity is invalid.",
            retryAfterSeconds: GITHUB_OBJECT_TTL_SECONDS,
          };
        }

        let token: string | null = null;
        try {
          token = typeof tokenProvider === "function" ? await tokenProvider(companyId, `${identity.owner}/${identity.repo}`) : tokenProvider;
        } catch {
          return {
            ok: false,
            liveness: "auth_required",
            errorCode: "github_token_unavailable",
            errorMessage: "Configured GitHub credentials could not be resolved.",
            retryAfterSeconds: GITHUB_OBJECT_TTL_SECONDS,
          };
        }
        token = token?.trim() || null;
        const headers: Record<string, string> = {
          accept: "application/vnd.github+json",
          "user-agent": "paperclip-external-object-resolver",
          "x-github-api-version": "2022-11-28",
        };
        if (token) headers.authorization = `Bearer ${token}`;
        if (object?.etag) headers["if-none-match"] = object.etag;
        else if (cached?.etag) headers["if-none-match"] = cached.etag;

        const apiKind = objectType === "pull_request" ? "pulls" : "issues";
        const url = `${gitHubApiBase(identity.host)}/repos/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.repo)}/${apiKind}/${identity.number}`;

        let response: Response;
        try {
          response = await fetchImpl(url, { headers });
          recordGitHubRequest(opts.source ?? "task-pr-sync", response);
        } catch {
          return {
            ok: false,
            liveness: "unreachable",
            errorCode: "github_fetch_failed",
            errorMessage: "GitHub could not be reached while refreshing this object.",
            retryAfterSeconds: GITHUB_OBJECT_TTL_SECONDS,
          };
        }

        if (response.status === 304) {
          // myrmidon(OPE-12397): a 304 to the cache's own etag replays the cached result; an etag the caller passed keeps its old meaning.
          if (cached && !object?.etag) return cached.result;
          return {
            ok: true,
            snapshot: {
              displayKey: object.displayKey,
              iconKey: object.iconKey,
              displayTitle: object.displayTitle,
              statusKey: object.statusKey,
              statusLabel: object.statusLabel,
              statusIconKey: object.statusIconKey,
              statusCategory: object.statusCategory,
              statusTone: object.statusTone,
              isTerminal: object.isTerminal,
              data: object.data,
              remoteVersion: object.remoteVersion,
              etag: object.etag,
              ttlSeconds: GITHUB_OBJECT_TTL_SECONDS,
            },
          };
        }

        const etag = response.headers?.get ? response.headers.get("etag") : null;
        if (response.status === 404) {
          return { ok: true, snapshot: notFoundSnapshot(identity, etag, Boolean(token)) };
        }

        const failure = failureFromGitHubResponse(response);
        if (failure) return failure;
        if (!response.ok) {
          return {
            ok: false,
            liveness: "unreachable",
            errorCode: "github_unexpected_response",
            errorMessage: `GitHub returned HTTP ${response.status} while refreshing this object.`,
            retryAfterSeconds: GITHUB_OBJECT_TTL_SECONDS,
          };
        }

        const body = await safeJson(response);
        if (!body) {
          return {
            ok: false,
            liveness: "unreachable",
            errorCode: "github_invalid_response",
            errorMessage: "GitHub returned an invalid object response.",
            retryAfterSeconds: GITHUB_OBJECT_TTL_SECONDS,
          };
        }

        if (objectType === "pull_request") {
          let mergeCommitReachable: boolean | undefined = undefined;
          const merged = (asBoolean(body.merged) ?? false) || Boolean(asString(body.merged_at));
          const baseRef = asNestedString(body, "base", "ref");
          const baseRepo = asRecord(asRecord(body.base)?.repo);
          const defaultBranch = asString(baseRepo?.default_branch) ?? "main";
          const mergeCommitSha = asString(body.merge_commit_sha);

          if (merged) {
            if (!baseRef || baseRef === defaultBranch || baseRef.startsWith("rel/")) {
              mergeCommitReachable = true;
            } else if (mergeCommitSha && !isGitHubRateLimited()) {
              // myrmidon(OPE-12397): no /compare once the budget is gone; the verdict stays "not reached" and is asked again later.
              try {
                const compareUrl = `${gitHubApiBase(identity.host)}/repos/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.repo)}/compare/${encodeURIComponent(defaultBranch)}...${encodeURIComponent(mergeCommitSha)}`;
                const compareRes = await fetchImpl(compareUrl, { headers });
                if (compareRes.ok) {
                  const compareBody = await safeJson(compareRes);
                  if (compareBody) {
                    const aheadBy = asNonNegativeInteger(compareBody.ahead_by);
                    const status = asString(compareBody.status);
                    mergeCommitReachable = aheadBy === 0 || status === "identical" || status === "behind";
                  }
                }
              } catch {
                mergeCommitReachable = false;
              }
            } else {
              mergeCommitReachable = false;
            }
          }

          return {
            ok: true,
            snapshot: pullRequestSnapshot(identity, body, etag, { mergeCommitReachable }),
          };
        }

        return {
          ok: true,
          snapshot: issueSnapshot(identity, body, etag),
        };
      },
    };

    return {
      providerKey: "github",
      objectType,
      async resolve({ companyId, object }) {
        const identity = parseGitHubObject(object);
        if (!identity || identity.objectType !== objectType) return network.resolve({ companyId, object });

        const ttlMs = readTtlSeconds(GITHUB_OBJECT_CACHE_TTL_ENV, DEFAULT_GITHUB_OBJECT_CACHE_TTL_SECONDS) * 1000;
        const terminalTtlMs = readTtlSeconds(GITHUB_OBJECT_TERMINAL_TTL_ENV, DEFAULT_GITHUB_OBJECT_TERMINAL_TTL_SECONDS) * 1000;
        const key = objectCacheKey(companyId, identity);
        const cached = ttlMs > 0 ? objectCache.get(key) : undefined;
        if (cached && Date.now() - cached.fetchedAt < (cached.terminal ? terminalTtlMs : ttlMs)) return cached.result;
        if (isGitHubRateLimited()) return cached ? cached.result : rateLimitedResult();
        if (ttlMs === 0) return network.resolve({ companyId, object });

        const running = objectReads.get(key);
        if (running) return running;
        const epoch = objectCacheEpoch;
        const read: Promise<ExternalObjectResolveResult> = network.resolve({ companyId, object, cached })
          .then((result) => {
            if (epoch === objectCacheEpoch) rememberGitHubObject(key, result);
            return result;
          })
          .finally(() => {
            if (objectReads.get(key) === read) objectReads.delete(key);
          });
        objectReads.set(key, read);
        return read;
      },
    };
  }

  return {
    detector,
    resolvers: [resolver("pull_request"), resolver("issue")],
  };
}
