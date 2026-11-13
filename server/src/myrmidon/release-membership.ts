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
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function isPresentCompare(body: CompareResponse): boolean {
  const status = typeof body.status === "string" ? body.status : "";
  const aheadBy = typeof body.ahead_by === "number" ? body.ahead_by : null;
  return aheadBy === 0 || status === "identical" || status === "behind";
}

export function normaliseReleasePrefix(label: string): string | null {
  const match = label.trim().match(/^(\d+\.\d+)$/);
  return match?.[1] ?? null;
}

export function releaseRefCandidates(prefix: string, refs: readonly ReleaseRef[] = []): ReleaseRef[] {
  const filtered = refs.filter((entry) => entry.ref.startsWith(`myr-v${prefix}`) || entry.ref.startsWith(`rel/${prefix}`));
  return filtered.length > 0 ? filtered : [
    { ref: `myr-v${prefix}`, kind: "tag" },
    { ref: `rel/${prefix}-fixes`, kind: "branch" },
  ];
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
