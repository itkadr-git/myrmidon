import { ghFetch, gitHubApiBase } from "./github-fetch.js";

export const NO_HOSTED_CI_SUMMARY = "CI в репозитории не настроен — ревью по локальным проверкам";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Only an authoritative directory listing can establish that hosted CI is absent. */
export async function repositoryHasHostedCi(input: {
  host?: "github.com";
  owner: string;
  repo: string;
  token: string | null;
  fetch?: FetchLike;
}): Promise<boolean | null> {
  const fetchImpl = input.fetch ?? ghFetch;
  const url = `${gitHubApiBase(input.host ?? "github.com")}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/.github/workflows`;
  const read = (token: string | null) => fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Myrmidon-CI-Resolver",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  try {
    let response = await read(input.token);
    const authenticatedStatus = response.status;
    if (input.token && [401, 403, 404].includes(response.status) && response.headers.get("x-ratelimit-remaining") !== "0") {
      response = await read(null);
    }
    if (response.status === 404) return authenticatedStatus === 401 || authenticatedStatus === 403 ? null : false;
    if (!response.ok) return null;
    const files: unknown = await response.json();
    if (!Array.isArray(files)) return null;
    return files.some((file) => file && typeof file === "object" &&
      "name" in file && typeof file.name === "string" && /\.ya?ml$/i.test(file.name));
  } catch {
    return null;
  }
}
