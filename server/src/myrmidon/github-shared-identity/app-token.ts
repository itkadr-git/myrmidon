// server/src/myrmidon/github-shared-identity/app-token.ts
//
// myrmidon(GITHUB-SHARED-IDENTITY): mint GitHub App installation tokens on
// the board itself — no external broker, no vendor App.
//
//   1. a JWT signed RS256 with the App's private key (iss = App id, 9 minutes);
//   2. the installation id: the configured one, or
//      `GET /repos/{owner}/{repo}/installation` (cached per App + repository);
//   3. `POST /app/installations/{id}/access_tokens` with
//      `repositories: [<repo>]` and exactly the permission list stored on the
//      App entry (plus metadata read, which GitHub grants to every
//      installation token anyway) — the token can touch exactly one
//      repository and only the keys the entry allows, whatever the App
//      registration allows beyond that.
//
// The default list is the historical fixed set (contents + pull requests
// write), so an unchanged installation keeps minting exactly the tokens it
// minted before. The token cache is keyed by the permission set: editing an
// entry's permissions re-mints instead of reusing a narrower/wider token.
//
// Tokens are cached in memory per (App, installation, repository,
// permissions) until five minutes before expiry. Neither the private key,
// the JWT nor the token ever reach a log line, an error message or persisted
// state: GitHub error bodies are reduced to the HTTP status.

import { createPrivateKey, createSign } from "node:crypto";
import { recordGitHubRequest } from "../../services/github-rate-limit.js";

/** One repository-permission key of the installation-token API. */
export const GITHUB_APP_TOKEN_PERMISSION_KEYS = [
  "actions",
  "checks",
  "contents",
  "deployments",
  "environments",
  "issues",
  "pull_requests",
  "workflows",
] as const;

export type GitHubAppPermissionKey = (typeof GITHUB_APP_TOKEN_PERMISSION_KEYS)[number];

/**
 * The levels a key may be stored at: `none` omits it from the token
 * request. GitHub's access-token body accepts only `read`/`write` per key;
 * `workflows` is `write`-only. Keys deliberately absent from the list
 * (secrets, administration, organization permissions) cannot be requested at
 * all — a stored document cannot widen beyond this allow-list.
 */
export function githubAppPermissionLevelsFor(key: GitHubAppPermissionKey): readonly ("read" | "write")[] {
  return key === "workflows" ? (["write"] as const) : (["read", "write"] as const);
}

export type GitHubAppPermissionLevel = "none" | "read" | "write";
/** The editable permission list of one App entry; every allow-listed key explicit. */
export type GitHubAppPermissions = Record<GitHubAppPermissionKey, GitHubAppPermissionLevel>;

/** The historical fixed set, minus the always-injected metadata read. */
export const DEFAULT_GITHUB_APP_PERMISSIONS = Object.freeze({
  actions: "none",
  checks: "none",
  contents: "write",
  deployments: "none",
  environments: "none",
  issues: "none",
  pull_requests: "write",
  workflows: "none",
} satisfies GitHubAppPermissions);

/** The permissions of an entry as the token request must carry them. */
export function githubAppTokenPermissionsFor(
  entry?: Partial<GitHubAppPermissions>,
): Record<string, "read" | "write"> {
  const source = { ...DEFAULT_GITHUB_APP_PERMISSIONS, ...(entry ?? {}) };
  const requested: Record<string, "read" | "write"> = { metadata: "read" };
  for (const key of GITHUB_APP_TOKEN_PERMISSION_KEYS) {
    const level = source[key];
    if (level === "none") continue;
    if (!githubAppPermissionLevelsFor(key).includes(level)) continue;
    requested[key] = level;
  }
  return requested;
}

const GITHUB_API = "https://api.github.com";
const TOKEN_REUSE_MARGIN_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

export class GitHubAppTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubAppTokenError";
  }
}

function base64UrlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function githubAppJwt(appId: string, privateKeyPem: string, now = new Date()): string {
  const epoch = Math.floor(now.getTime() / 1000);
  const unsigned = `${base64UrlJson({ alg: "RS256", typ: "JWT" })}.${base64UrlJson({ iat: epoch - 60, exp: epoch + 540, iss: appId })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  let key;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch {
    throw new GitHubAppTokenError("The GitHub App private key is not a valid PEM key");
  }
  return `${unsigned}.${signer.sign(key).toString("base64url")}`;
}

type CachedToken = { token: string; expiresAt: number };
const tokenCache = new Map<string, CachedToken>();
const installationCache = new Map<string, string>();
// myrmidon(OPE-12446): single-flight minting. Concurrent requests for the same
// (App, installation, repository, permission set) join one in-flight mint
// instead of each missing the not-yet-populated token cache and POSTing its
// own access token: a credential storm outpacing one mint was exhausting the
// installation's 5000/hour budget (852 credentials requests in 10 minutes).
const tokenInflight = new Map<string, Promise<{ token: string; expiresAt: string; installationId: string; reused: boolean }>>();
const installationInflight = new Map<string, Promise<string>>();

const resetListeners: Array<() => void> = [];
export function onResetGitHubAppTokenCache(fn: () => void) {
  resetListeners.push(fn);
}

/** Tests only: forget cached tokens, installation ids and in-flight mints. */
export function resetGitHubAppTokenCacheForTests() {
  tokenCache.clear();
  installationCache.clear();
  tokenInflight.clear();
  installationInflight.clear();
  for (const fn of resetListeners) {
    try {
      fn();
    } catch {
      // Ignore listener errors during cache reset
    }
  }
}

async function githubRequest(
  fetchImpl: typeof fetch,
  method: "GET" | "POST",
  path: string,
  jwt: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(`${GITHUB_API}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "myrmidon-github-app",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    recordGitHubRequest("broker", response);
  } catch {
    throw new GitHubAppTokenError("GitHub is unreachable");
  }
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    throw new GitHubAppTokenError(`GitHub answered HTTP ${response.status} for ${method} ${path}`);
  }
  const parsed = await response.json().catch(() => null);
  if (!parsed || typeof parsed !== "object") throw new GitHubAppTokenError("GitHub returned an unreadable answer");
  return parsed as Record<string, unknown>;
}

async function resolveInstallationId(input: {
  appId: string;
  privateKeyPem: string | (() => Promise<string> | string);
  repository: string;
  explicitInstallationId: string | null;
  fetchImpl: typeof fetch;
  now: () => number;
}): Promise<string> {
  if (input.explicitInstallationId) {
    return String(input.explicitInstallationId).trim();
  }
  const repoKey = input.repository.toLowerCase();
  const installationKey = `${input.appId}:${repoKey}`;
  const cached = installationCache.get(installationKey);
  if (cached) return cached;

  const inflight = installationInflight.get(installationKey);
  if (inflight) return inflight;

  const promise = (async () => {
    const pem = typeof input.privateKeyPem === "function" ? await input.privateKeyPem() : input.privateKeyPem;
    const [owner, repo] = input.repository.split("/") as [string, string];
    const jwt = githubAppJwt(input.appId, pem, new Date(input.now()));
    const installation = await githubRequest(
      input.fetchImpl,
      "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
      jwt,
    );
    const id = installation.id;
    if (typeof id !== "number" && typeof id !== "string") {
      throw new GitHubAppTokenError("The GitHub App is not installed on this repository");
    }
    const resolvedId = String(id);
    installationCache.set(installationKey, resolvedId);
    return resolvedId;
  })().finally(() => {
    if (installationInflight.get(installationKey) === promise) {
      installationInflight.delete(installationKey);
    }
  });

  installationInflight.set(installationKey, promise);
  return promise;
}

export async function mintGitHubAppInstallationToken(input: {
  appId: string;
  privateKeyPem: string | (() => Promise<string> | string);
  installationId: string | null;
  /** Normalized `owner/repo`. */
  repository: string;
  /** The entry's permission list; omitted = the historical fixed set. */
  permissions?: Partial<GitHubAppPermissions>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<{ token: string; expiresAt: string; installationId: string; reused: boolean }> {
  const now = input.now ?? Date.now;
  const repoKey = input.repository.toLowerCase();
  const fetchImpl = input.fetchImpl ?? fetch;
  const requestedPermissions = githubAppTokenPermissionsFor(input.permissions);
  const permissionsKey = GITHUB_APP_TOKEN_PERMISSION_KEYS.map((key) => `${key}=${requestedPermissions[key] ?? "none"}`).join(",");

  // One lazy read per mint call: the installation lookup and the mint flight
  // share the same promise, so a cold mint resolves the secret exactly once
  // (previously twice when the installation id had to be discovered) and warm
  // paths — token cache hit or joining an in-flight mint — resolve it zero
  // times. Every avoided read is one fewer row in secret_access_events.
  let pemPromise: Promise<string> | null = null;
  const resolvePem = (): Promise<string> => {
    if (!pemPromise) {
      pemPromise = (async () => {
        return typeof input.privateKeyPem === "function" ? await input.privateKeyPem() : input.privateKeyPem;
      })();
    }
    return pemPromise;
  };

  // Check cache early if installationId is explicitly known or cached
  const knownInstallationId = input.installationId
    ? String(input.installationId).trim()
    : installationCache.get(`${input.appId}:${repoKey}`) ?? null;

  if (knownInstallationId) {
    const cacheKey = `${input.appId}:${knownInstallationId}:${repoKey}:${permissionsKey}`;
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt - TOKEN_REUSE_MARGIN_MS > now()) {
      return { token: cached.token, expiresAt: new Date(cached.expiresAt).toISOString(), installationId: knownInstallationId, reused: true };
    }
    const inflight = tokenInflight.get(cacheKey);
    if (inflight) return inflight.then((minted) => ({ ...minted, reused: true }));
  }

  const installationId = await resolveInstallationId({
    appId: input.appId,
    privateKeyPem: resolvePem,
    repository: input.repository,
    explicitInstallationId: input.installationId,
    fetchImpl,
    now,
  });

  // Single-flight and cache keyed by (App, installation, repository, permissions)
  const cacheKey = `${input.appId}:${installationId}:${repoKey}:${permissionsKey}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt - TOKEN_REUSE_MARGIN_MS > now()) {
    return { token: cached.token, expiresAt: new Date(cached.expiresAt).toISOString(), installationId, reused: true };
  }

  const inflight = tokenInflight.get(cacheKey);
  // A caller that joins an in-flight mint rides the token that flight produces —
  // it spent no installation budget of its own, so it reports `reused: true`
  // exactly like a cache hit and the journal records a single issue instead
  // of one per joining caller.
  if (inflight) return inflight.then((minted) => ({ ...minted, reused: true }));

  const mint = (async () => {
    const pem = await resolvePem();
    const jwt = githubAppJwt(input.appId, pem, new Date(now()));
    const [, repo] = input.repository.split("/") as [string, string];
    const issued = await githubRequest(
      fetchImpl,
      "POST",
      `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      jwt,
      { repositories: [repo], permissions: requestedPermissions },
    );
    const token = typeof issued.token === "string" ? issued.token : "";
    const expiresAtMs = typeof issued.expires_at === "string" ? Date.parse(issued.expires_at) : Number.NaN;
    if (!token || !Number.isFinite(expiresAtMs)) throw new GitHubAppTokenError("GitHub returned no installation token");
    tokenCache.set(cacheKey, { token, expiresAt: expiresAtMs });
    return { token, expiresAt: new Date(expiresAtMs).toISOString(), installationId, reused: false };
  })().finally(() => {
    if (tokenInflight.get(cacheKey) === mint) tokenInflight.delete(cacheKey);
  });

  tokenInflight.set(cacheKey, mint);
  return mint;
}
