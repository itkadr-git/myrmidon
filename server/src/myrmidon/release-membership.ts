import { gitHubApiBase } from "../services/github-fetch.js";

export type ReleaseMembershipVerdict = "present" | "missing_from_release" | "unknown";

export type ReleaseRef = { ref: string; kind: "tag" | "branch" };

export type ReleaseCommitCheck = {
  ref: string;
  kind: ReleaseRef["kind"];
  inRelease: boolean | null;
};

export type ReleaseMembership = {
  releasePrefix: string;
  releaseRefs: ReleaseRef[];
  checks: ReleaseCommitCheck[];
  verdict: ReleaseMembershipVerdict;
};

type CompareResponse = { status?: unknown; ahead_by?: unknown; behind_by?: unknown };
type MatchingRefsResponse = Array<{ ref?: unknown }>;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function isPresentCompare(body: CompareResponse): boolean {
  const status = typeof body.status === "string" ? body.status : "";
  const aheadBy = typeof body.ahead_by === "number" ? body.ahead_by : null;
  return aheadBy === 0 || status === "identical" || status === "behind";
}

/** Matches refs of one release line: "1.6" keeps myr-v1.6.8 / rel/1.6.8-fixes, drops myr-v1.60.1 / myr-v1.7.0. */
function releaseLineRegExp(marker: string, prefix: string): RegExp {
  return new RegExp(`^${marker}${prefix.replace(/\./g, "\\.")}(?!\\d)`);
}

export function normaliseReleasePrefix(label: string): string | null {
  const match = label.trim().match(/^(\d+\.\d+)$/);
  return match?.[1] ?? null;
}

export function releaseRefCandidates(prefix: string, refs: readonly ReleaseRef[] = []): ReleaseRef[] {
  const tagLine = releaseLineRegExp("myr-v", prefix);
  const branchLine = releaseLineRegExp("rel/", prefix);
  const filtered = refs.filter((entry) => tagLine.test(entry.ref) || branchLine.test(entry.ref));
  return filtered.length > 0 ? filtered : [
    { ref: `myr-v${prefix}`, kind: "tag" },
    { ref: `rel/${prefix}-fixes`, kind: "branch" },
  ];
}

/**
 * Release refs actually present in the repository: tags myr-v<prefix>* and
 * branches rel/<prefix>* of the release line. Empty on ref-API failure — the
 * caller then falls back to releaseRefCandidates defaults.
 */
export async function resolveReleaseRefs(options: {
  repository: string;
  releasePrefix: string;
  token?: string | null;
  host?: string;
  fetchImpl?: FetchLike;
}): Promise<ReleaseRef[]> {
  const [owner, repo] = options.repository.split("/");
  if (!owner || !repo) return [];
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = gitHubApiBase(options.host ?? "github.com");
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  if (options.token?.trim()) headers.authorization = `Bearer ${options.token.trim()}`;
  const endpoint = (kind: "tags" | "branches", marker: string) =>
    `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/matching-refs/${kind}/${encodeURIComponent(`${marker}${options.releasePrefix}`)}`;
  const found: ReleaseRef[] = [];
  for (const [kind, strip] of [["tags", "refs/tags/"], ["branches", "refs/heads/"]] as const) {
    try {
      const response = await fetchImpl(endpoint(kind, kind === "tags" ? "myr-v" : "rel/"), { headers });
      if (!response.ok) continue;
      const body = await response.json() as MatchingRefsResponse;
      if (!Array.isArray(body)) continue;
      for (const entry of body) {
        const name = typeof entry.ref === "string" ? entry.ref.replace(strip, "") : "";
        if (!name) continue;
        if (releaseLineRegExp(kind === "tags" ? "myr-v" : "rel/", options.releasePrefix).test(name)) {
          found.push({ ref: name, kind: kind === "tags" ? "tag" : "branch" });
        }
      }
    } catch {
      // one kind failing must not hide the other; the caller falls back if both fail
    }
  }
  return found;
}

export async function checkCommitInRef(options: {
  repository: string;
  ref: ReleaseRef;
  sha: string;
  token?: string | null;
  host?: string;
  fetchImpl?: FetchLike;
}): Promise<boolean | null> {
  const [owner, repo] = options.repository.split("/");
  if (!owner || !repo || !options.sha) return null;
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = gitHubApiBase(options.host ?? "github.com");
  const url = `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(options.ref.ref)}...${encodeURIComponent(options.sha)}`;
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  if (options.token?.trim()) headers.authorization = `Bearer ${options.token.trim()}`;
  try {
    const response = await fetchImpl(url, { headers });
    if (response.status === 404) return null;
    if (!response.ok) return null;
    const body = await response.json() as CompareResponse;
    return isPresentCompare(body);
  } catch {
    return null;
  }
}

export async function checkCommitMembership(options: {
  repository: string;
  sha: string | null;
  releasePrefix: string;
  refs?: readonly ReleaseRef[];
  token?: string | null;
  host?: string;
  fetchImpl?: FetchLike;
}): Promise<ReleaseMembership> {
  const candidates = releaseRefCandidates(options.releasePrefix, options.refs);
  if (!options.sha) return { releasePrefix: options.releasePrefix, releaseRefs: candidates, checks: [], verdict: "unknown" };
  const checks = await Promise.all(candidates.map(async (ref) => ({
    ref: ref.ref,
    kind: ref.kind,
    inRelease: await checkCommitInRef({ ...options, ref, sha: options.sha! }),
  })));
  const known = checks.filter((check) => check.inRelease !== null);
  const verdict: ReleaseMembershipVerdict = known.some((check) => check.inRelease === true)
    ? "present"
    : known.length > 0 ? "missing_from_release" : "unknown";
  return { releasePrefix: options.releasePrefix, releaseRefs: candidates, checks, verdict };
}

export type RoutePullRequestVerdict = "present" | "missing_from_release" | "no_release_label" | "unknown";

export function routePullRequestVerdict(options: {
  merged: boolean;
  releaseLabel: string | null;
  membershipVerdict: ReleaseMembershipVerdict;
  inDefaultBranch: boolean | null;
}): RoutePullRequestVerdict {
  if (!options.merged) return "unknown";
  if (!options.releaseLabel) return "no_release_label";
  if (options.membershipVerdict === "present") return "present";
  if (options.membershipVerdict === "missing_from_release" && options.inDefaultBranch) {
    return "missing_from_release";
  }
  return "unknown";
}
