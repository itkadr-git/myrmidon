import { describe, expect, it } from "vitest";
import {
  checkCommitInRef,
  checkCommitMembership,
  normaliseReleasePrefix,
  releaseRefCandidates,
  type ReleaseRef,
} from "./release-membership.js";

const REPO = "acme/project";
const SHA = "abc123def456abc123def456abc123def456abc1";

function compareResponse(status: string, aheadBy: number): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ status, ahead_by: aheadBy }),
  } as unknown as Response;
}

function fetchFake(responses: Record<string, Response>, calls: string[] = []) {
  return (input: string) => {
    calls.push(input);
    const url = new URL(input);
    const compareRef = decodeURIComponent(url.pathname.replace(/^\/repos\/[^/]+\/[^/]+\/compare\//, ""));
    const response = Object.entries(responses).find(([key]) => compareRef.startsWith(key))?.[1];
    if (!response) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as unknown as Response);
    return Promise.resolve(response);
  };
}

describe("normaliseReleasePrefix", () => {
  it("accepts a <major>.<minor> release label and rejects everything else", () => {
    expect(normaliseReleasePrefix("1.6")).toBe("1.6");
    expect(normaliseReleasePrefix(" 1.6 ")).toBe("1.6");
    expect(normaliseReleasePrefix("1.6.8")).toBeNull();
    expect(normaliseReleasePrefix("release")).toBeNull();
    expect(normaliseReleasePrefix("")).toBeNull();
  });
});

describe("releaseRefCandidates", () => {
  it("falls back to the release tag and fixes branch for a prefix", () => {
    expect(releaseRefCandidates("1.6")).toEqual([
      { ref: "myr-v1.6", kind: "tag" },
      { ref: "rel/1.6-fixes", kind: "branch" },
    ]);
  });

  it("keeps only refs of the release line when a list is provided", () => {
    const refs: ReleaseRef[] = [
      { ref: "myr-v1.6", kind: "tag" },
      { ref: "myr-v1.6.8", kind: "tag" },
      { ref: "rel/1.6-fixes", kind: "branch" },
      { ref: "rel/1.7-rc.1", kind: "branch" },
      { ref: "main", kind: "branch" },
    ];
    expect(releaseRefCandidates("1.6", refs)).toEqual([
      { ref: "myr-v1.6", kind: "tag" },
      { ref: "myr-v1.6.8", kind: "tag" },
      { ref: "rel/1.6-fixes", kind: "branch" },
    ]);
  });
});

describe("checkCommitInRef", () => {
  it("reports membership when the compare against the release ref is behind", async () => {
    const calls: string[] = [];
    const fetchImpl = fetchFake({ "myr-v1.6...abc123": compareResponse("behind", 3) }, calls);
    const result = await checkCommitInRef({
      repository: REPO,
      ref: { ref: "myr-v1.6", kind: "tag" },
      sha: SHA,
      fetchImpl,
    });
    expect(result).toBe(true);
    expect(calls[0]).toContain("/repos/acme/project/compare/myr-v1.6...");
  });

  it("reports membership when the compare status is identical", async () => {
    const fetchImpl = fetchFake({ "myr-v1.6...abc123": compareResponse("identical", 0) });
    expect(await checkCommitInRef({
      repository: REPO,
      ref: { ref: "myr-v1.6", kind: "tag" },
      sha: SHA,
      fetchImpl,
    })).toBe(true);
  });

  it("reports absence when the release ref is ahead of the commit", async () => {
    const fetchImpl = fetchFake({ "myr-v1.6...abc123": compareResponse("diverged", 5) });
    expect(await checkCommitInRef({
      repository: REPO,
      ref: { ref: "myr-v1.6", kind: "tag" },
      sha: SHA,
      fetchImpl,
    })).toBe(false);
  });

  it("yields unknown on ref not found, unexpected HTTP errors and network failures", async () => {
    expect(await checkCommitInRef({
      repository: REPO,
      ref: { ref: "myr-v1.6", kind: "tag" },
      sha: SHA,
      fetchImpl: fetchFake({}),
    })).toBeNull();
    expect(await checkCommitInRef({
      repository: REPO,
      ref: { ref: "myr-v1.6", kind: "tag" },
      sha: SHA,
      fetchImpl: () => Promise.reject(new Error("network down")),
    })).toBeNull();
  });
});

describe("checkCommitMembership", () => {
  it("flags missing_from_release when the PR is merged only into main and is absent from every release ref", async () => {
    const fetchImpl = fetchFake({
      "myr-v1.6...abc123": compareResponse("diverged", 12),
      "rel/1.6-fixes...abc123": compareResponse("diverged", 8),
    });
    const membership = await checkCommitMembership({
      repository: REPO,
      sha: SHA,
      releasePrefix: "1.6",
      fetchImpl,
    });
    expect(membership.verdict).toBe("missing_from_release");
    expect(membership.checks.map((check) => [check.ref, check.inRelease])).toEqual([
      ["myr-v1.6", false],
      ["rel/1.6-fixes", false],
    ]);
  });

  it("flags present as soon as one release ref contains the commit", async () => {
    const fetchImpl = fetchFake({
      "myr-v1.6...abc123": compareResponse("diverged", 12),
      "rel/1.6-fixes...abc123": compareResponse("behind", 0),
    });
    const membership = await checkCommitMembership({
      repository: REPO,
      sha: SHA,
      releasePrefix: "1.6",
      fetchImpl,
    });
    expect(membership.verdict).toBe("present");
  });

  it("stays unknown without a merge commit sha", async () => {
    const calls: string[] = [];
    const membership = await checkCommitMembership({
      repository: REPO,
      sha: null,
      releasePrefix: "1.6",
      fetchImpl: fetchFake({}, calls),
    });
    expect(membership.verdict).toBe("unknown");
    expect(calls).toEqual([]);
    expect(membership.releaseRefs).toEqual([
      { ref: "myr-v1.6", kind: "tag" },
      { ref: "rel/1.6-fixes", kind: "branch" },
    ]);
  });

  it("stays unknown when every release ref check is inconclusive", async () => {
    const membership = await checkCommitMembership({
      repository: REPO,
      sha: SHA,
      releasePrefix: "1.6",
      fetchImpl: fetchFake({}),
    });
    expect(membership.verdict).toBe("unknown");
  });
});
