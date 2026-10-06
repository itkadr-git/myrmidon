// server/src/myrmidon/github-shared-identity/app-token.ts
//
// myrmidon(GITHUB-SHARED-IDENTITY): mint GitHub App installation tokens on
// the board itself — no external broker, no vendor App.
//
//   1. a JWT signed RS256 with the App's private key (iss = App id, 9 minutes);
//   2. the installation id: the configured one, or
//      `GET /repos/{owner}/{repo}/installation` (cached per App + repository);
//   3. `POST /app/installations/{id}/access_tokens` with
//      `repositories: [<repo>]` and the fixed minimal permission set below —
//      the token can touch exactly one repository and nothing beyond code
//      and pull requests, whatever the App registration allows.
//
// Tokens are cached in memory per (App, installation, repository) until five
// minutes before expiry. Neither the private key, the JWT nor the token ever
// reach a log line, an error message or persisted state: GitHub error bodies
// are reduced to the HTTP status.

import { createPrivateKey, createSign } from "node:crypto";

/** The only permissions an issued token carries. */
export const GITHUB_APP_TOKEN_PERMISSIONS = Object.freeze({
  contents: "write",
  pull_requests: "write",
  metadata: "read",
} as const);

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

/** Tests only: forget cached tokens and installation ids. */
export function resetGitHubAppTokenCacheForTests() {
  tokenCache.clear();
  installationCache.clear();
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

export async function mintGitHubAppInstallationToken(input: {
  appId: string;
  privateKeyPem: string;
  installationId: string | null;
  /** Normalized `owner/repo`. */
  repository: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<{ token: string; expiresAt: string; installationId: string; reused: boolean }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const [owner, repo] = input.repository.split("/") as [string, string];
  const repoKey = input.repository.toLowerCase();
  const installationKey = `${input.appId}:${repoKey}`;
  let installationId = input.installationId ?? installationCache.get(installationKey) ?? null;
  const cacheKey = (id: string) => `${input.appId}:${id}:${repoKey}`;
  if (installationId) {
    const cached = tokenCache.get(cacheKey(installationId));
    if (cached && cached.expiresAt - TOKEN_REUSE_MARGIN_MS > now()) {
      return { token: cached.token, expiresAt: new Date(cached.expiresAt).toISOString(), installationId, reused: true };
    }
  }
  const jwt = githubAppJwt(input.appId, input.privateKeyPem, new Date(now()));
  if (!installationId) {
    const installation = await githubRequest(
      fetchImpl, "GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`, jwt,
    );
    const id = installation.id;
    if (typeof id !== "number" && typeof id !== "string") {
      throw new GitHubAppTokenError("The GitHub App is not installed on this repository");
    }
    installationId = String(id);
    installationCache.set(installationKey, installationId);
  }
  const issued = await githubRequest(
    fetchImpl,
    "POST",
    `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    jwt,
    { repositories: [repo], permissions: GITHUB_APP_TOKEN_PERMISSIONS },
  );
  const token = typeof issued.token === "string" ? issued.token : "";
  const expiresAtMs = typeof issued.expires_at === "string" ? Date.parse(issued.expires_at) : Number.NaN;
  if (!token || !Number.isFinite(expiresAtMs)) throw new GitHubAppTokenError("GitHub returned no installation token");
  tokenCache.set(cacheKey(installationId), { token, expiresAt: expiresAtMs });
  return { token, expiresAt: new Date(expiresAtMs).toISOString(), installationId, reused: false };
}
