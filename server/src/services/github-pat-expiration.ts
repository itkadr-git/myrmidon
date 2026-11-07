const GITHUB_USER_URL = "https://api.github.com/user";
const WARNING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function parseGitHubPatExpiration(header: string | null): string | null {
  if (!header) return null;
  const timestamp = Date.parse(header);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function isGitHubPatExpiring(expiration: string | null, now = Date.now()): boolean {
  if (!expiration) return false;
  const timestamp = Date.parse(expiration);
  return Number.isFinite(timestamp) && timestamp <= now + WARNING_WINDOW_MS;
}

/** Only the expiration header is retained; the token and response body are never logged. */
export async function readGitHubPatExpiration(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!token.startsWith("github_pat_")) return null;
  const response = await fetchImpl(GITHUB_USER_URL, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "myrmidon-secrets",
    },
  });
  if (!response.ok) return null;
  return parseGitHubPatExpiration(response.headers.get("github-authentication-token-expiration"));
}
