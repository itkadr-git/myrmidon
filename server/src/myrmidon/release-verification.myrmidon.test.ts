import { describe, expect, it } from "vitest";

import {
  buildReleaseCandidateMembers,
  composeReleaseVerdict,
  verifyReleaseComposition,
  type ReleaseCandidateMember,
} from "./release-verification.js";

const REPO = "acme/project";
const SHA_A = "aaa111aaa111aaa111aaa111aaa111aaa111aaa1";
const SHA_B = "bbb222bbb222bbb222bbb222bbb222bbb222bbb2";
const SHA_C = "ccc333ccc333ccc333ccc333ccc333ccc333ccc3";

/**
 * Build a fetch fake keyed by compare-ref prefix, mirroring the
 * release-membership test harness. "identical"/ahead_by 0 => present,
 * "diverged"/ahead_by > 0 => missing, 404 => unknown.
 */
function compareFake(
  presentRefs: string[],
  missingRefs: string[] = [],
  calls: string[] = [],
): (input: string, init?: RequestInit) => Promise<Response> {
  return (input: string) => {
    calls.push(input);
    const url = new URL(input);
    const compareRef = decodeURIComponent(
      url.pathname.replace(/^\/repos\/[^/]+\/[^/]+\/compare\//, ""),
    );
    const base = compareRef.split("...")[0];
    const body = presentRefs.includes(base)
      ? { status: "identical", ahead_by: 0 }
      : missingRefs.includes(base)
        ? { status: "diverged", ahead_by: 3 }
        : null;
    if (body === null) {
      return Promise.resolve({
        ok: false,
        status: 404,
        json: async () => ({}),
      } as unknown as Response);
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => body,
    } as unknown as Response);
  };
}

function member(id: string, sha: string | null, merged = true): ReleaseCandidateMember {
  return { id, repository: REPO, mergeCommitSha: sha, merged };
}

const NOW = () => new Date("2026-11-13T12:00:00.000Z");

describe("composeReleaseVerdict", () => {
  it("treats an empty candidate set as a failure, never a success", () => {
    const result = composeReleaseVerdict([]);
    expect(result.verdict).toBe("failed");
    expect(result.failureReason).toBe("empty_candidate_set");
  });

  it("confirms only when every member is present", () => {
    const result = composeReleaseVerdict(["present", "present", "present"]);
    expect(result.verdict).toBe("confirmed");
    expect(result.failureReason).toBeNull();
  });

  it("fails when any member is missing from the release", () => {
    const result = composeReleaseVerdict(["present", "missing_from_release"]);
    expect(result.verdict).toBe("failed");
    expect(result.failureReason).toBe("member_missing_from_release");
  });

  it("fails when the deployed version is unknown / membership unresolvable", () => {
    const result = composeReleaseVerdict(["present", "unknown"]);
    expect(result.verdict).toBe("failed");
    expect(result.failureReason).toBe("deployed_version_unknown");
  });
});

describe("verifyReleaseComposition", () => {
  it("confirms the release when every candidate member is present", async () => {
    const calls: string[] = [];
    const result = await verifyReleaseComposition({
      releasePrefix: "1.6",
      deployedVersion: "myr-v1.6.8",
      members: [member("OPE-1", SHA_A), member("OPE-2", SHA_B)],
      resolvedRefs: [{ ref: "myr-v1.6.8", kind: "tag" }],
      refs: [{ ref: "myr-v1.6.8", kind: "tag" }],
      fetchImpl: compareFake(["myr-v1.6.8"], [], calls),
      now: NOW,
    });

    expect(result.verdict).toBe("confirmed");
    expect(result.failureReason).toBeNull();
    expect(result.allMembersPresent).toBe(true);
    expect(result.members).toHaveLength(2);
    expect(result.members.every((m) => m.membership === "present")).toBe(true);
    expect(result.checkedAt).toBe("2026-11-13T12:00:00.000Z");
    // Both members were actually checked against the release contract.
    // The explicit ref list overrides the default candidates, so each member
    // is checked against exactly one ref: 2 members × 1 ref = 2 calls.
    expect(calls.length).toBe(2);
  });

  it("fails the release with a reason when one member is missing", async () => {
    const resolvedRefs = [{ ref: "myr-v1.6.8", kind: "tag" as const }];
    const result = await verifyReleaseComposition({
      releasePrefix: "1.6",
      deployedVersion: "myr-v1.6.8",
      members: [member("OPE-1", SHA_A), member("OPE-2", SHA_B)],
      resolvedRefs,
      refs: resolvedRefs,
      fetchImpl: compareFake(["myr-v1.6.8"], [], []),
      now: NOW,
    });

    // Make the second member missing by pointing the fake the other way.
    const failing = await verifyReleaseComposition({
      releasePrefix: "1.6",
      deployedVersion: "myr-v1.6.8",
      members: [member("OPE-1", SHA_A), member("OPE-2", SHA_B)],
      resolvedRefs,
      refs: resolvedRefs,
      fetchImpl: (input) => {
        const url = new URL(input);
        const sha = url.pathname.split("...")[1];
        const present = sha === SHA_A;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () =>
            present ? { status: "identical", ahead_by: 0 } : { status: "diverged", ahead_by: 4 },
        } as unknown as Response);
      },
      now: NOW,
    });

    expect(result.verdict).toBe("confirmed");
    expect(failing.verdict).toBe("failed");
    expect(failing.failureReason).toBe("member_missing_from_release");
    expect(failing.allMembersPresent).toBe(false);
    expect(failing.reason).toMatch(/отсутствуют 1 из 2/);
  });

  it("fails with empty_candidate_set when the candidate list is empty", async () => {
    const result = await verifyReleaseComposition({
      releasePrefix: "1.6",
      deployedVersion: "myr-v1.6.8",
      members: [],
      resolvedRefs: [{ ref: "myr-v1.6.8", kind: "tag" }],
      now: NOW,
    });
    expect(result.verdict).toBe("failed");
    expect(result.failureReason).toBe("empty_candidate_set");
    expect(result.allMembersPresent).toBe(false);
  });

  it("fails with member_sha_missing when a member has no merge SHA", async () => {
    const result = await verifyReleaseComposition({
      releasePrefix: "1.6",
      deployedVersion: "myr-v1.6.8",
      members: [member("OPE-1", SHA_A), member("OPE-2", null)],
      resolvedRefs: [{ ref: "myr-v1.6.8", kind: "tag" }],
      fetchImpl: compareFake(["myr-v1.6.8"], [], []),
      now: NOW,
    });
    expect(result.verdict).toBe("failed");
    expect(result.failureReason).toBe("member_sha_missing");
    expect(result.reason).toContain("OPE-2");
    expect(result.allMembersPresent).toBe(false);
  });

  it("fails with deployed_version_unknown when membership is unresolvable", async () => {
    // All compare calls 404 => membership verdict "unknown" for every member.
    const result = await verifyReleaseComposition({
      releasePrefix: "1.6",
      deployedVersion: null,
      members: [member("OPE-1", SHA_A), member("OPE-2", SHA_B)],
      fetchImpl: compareFake([], [], []),
      now: NOW,
    });
    expect(result.verdict).toBe("failed");
    expect(result.failureReason).toBe("deployed_version_unknown");
    expect(result.deployedVersion).toBeNull();
    expect(result.allMembersPresent).toBe(false);
  });

  it("fails with deployed_version_unknown when deployedVersion is not supplied, even if member SHAs resolve", async () => {
    // The deployed version guard runs before any membership checks, so no
    // fetch calls are expected even when the fake would return "present".
    const calls: string[] = [];
    const result = await verifyReleaseComposition({
      releasePrefix: "1.6",
      deployedVersion: null,
      members: [member("OPE-1", SHA_A), member("OPE-2", SHA_B)],
      fetchImpl: compareFake(["myr-v1.6"], [], calls),
      now: NOW,
    });
    expect(result.verdict).toBe("failed");
    expect(result.failureReason).toBe("deployed_version_unknown");
    expect(result.deployedVersion).toBeNull();
    expect(result.members).toHaveLength(0);
    expect(result.allMembersPresent).toBe(false);
    // The version guard short-circuits before any membership check.
    expect(calls).toHaveLength(0);
  });

  it("fails with deployed_version_unknown when deployedVersion is undefined", async () => {
    const calls: string[] = [];
    const result = await verifyReleaseComposition({
      releasePrefix: "1.6",
      members: [member("OPE-1", SHA_A)],
      fetchImpl: compareFake(["myr-v1.6"], [], calls),
      now: NOW,
    });
    expect(result.verdict).toBe("failed");
    expect(result.failureReason).toBe("deployed_version_unknown");
    expect(result.deployedVersion).toBeNull();
    expect(result.allMembersPresent).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("checks every member against the release line, not just the first", async () => {
    const seen: string[] = [];
    await verifyReleaseComposition({
      releasePrefix: "1.6",
      deployedVersion: "myr-v1.6.8",
      members: [member("OPE-1", SHA_A), member("OPE-2", SHA_B), member("OPE-3", SHA_C)],
      resolvedRefs: [{ ref: "myr-v1.6.8", kind: "tag" }],
      fetchImpl: (input) => {
        seen.push(input);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ status: "identical", ahead_by: 0 }),
        } as unknown as Response);
      },
      now: NOW,
    });
    // 3 members × 2 default release refs = 6 calls.
    expect(seen).toHaveLength(6);
  });

  it("fails with deployed_version_mismatch when deployedVersion is not among the resolved release refs", async () => {
    // The deployed version must correspond to a real release ref; an arbitrary
    // non-empty string must not let membership checks run and claim success.
    const calls: string[] = [];
    const result = await verifyReleaseComposition({
      releasePrefix: "1.6",
      deployedVersion: "myr-v1.6.99-fabricated",
      members: [member("OPE-1", SHA_A)],
      resolvedRefs: [
        { ref: "myr-v1.6.8", kind: "tag" },
        { ref: "rel/1.6-fixes", kind: "branch" },
      ],
      fetchImpl: compareFake(["myr-v1.6.8"], [], calls),
      now: NOW,
    });
    expect(result.verdict).toBe("failed");
    expect(result.failureReason).toBe("deployed_version_mismatch");
    expect(result.reason).toMatch(/myr-v1\.6\.99-fabricated/);
    expect(result.allMembersPresent).toBe(false);
    // The mismatch guard short-circuits before any membership check.
    expect(calls).toHaveLength(0);
  });

  it("confirms when deployedVersion matches a resolved release ref and all members are present", async () => {
    const calls: string[] = [];
    const result = await verifyReleaseComposition({
      releasePrefix: "1.6",
      deployedVersion: "myr-v1.6.8",
      members: [member("OPE-1", SHA_A)],
      resolvedRefs: [
        { ref: "myr-v1.6.8", kind: "tag" },
        { ref: "rel/1.6-fixes", kind: "branch" },
      ],
      refs: [{ ref: "myr-v1.6.8", kind: "tag" }],
      fetchImpl: compareFake(["myr-v1.6.8"], [], calls),
      now: NOW,
    });
    expect(result.verdict).toBe("confirmed");
    expect(result.failureReason).toBeNull();
    expect(result.allMembersPresent).toBe(true);
    expect(calls.length).toBe(1);
  });

  it("confirms when deployedVersion is git-describe output anchored at a resolved ref", async () => {
    // The build stamp is usually `git describe` ("v1.6.8-15-g4c55f0d"), not a
    // bare tag; it must still count as matching the resolved release tag.
    const calls: string[] = [];
    const result = await verifyReleaseComposition({
      releasePrefix: "1.6",
      deployedVersion: "myr-v1.6.8-15-g4c55f0d",
      members: [member("OPE-1", SHA_A)],
      resolvedRefs: [
        { ref: "myr-v1.6.8", kind: "tag" },
        { ref: "rel/1.6-fixes", kind: "branch" },
      ],
      refs: [{ ref: "myr-v1.6.8", kind: "tag" }],
      fetchImpl: compareFake(["myr-v1.6.8"], [], calls),
      now: NOW,
    });
    expect(result.verdict).toBe("confirmed");
    expect(result.failureReason).toBeNull();
    expect(result.allMembersPresent).toBe(true);
  });

  it("fails closed with deployed_version_unknown when resolvedRefs is empty, even if membership would resolve present", async () => {
    // Review finding (PR #3093, second round): when the repository ref
    // listing comes back empty (API failure, missing tags/branches, or no PR
    // work products to name a repo), the deployed version cannot be tied to
    // any real release ref. Falling through to membership checks against the
    // default prefix refs would let an arbitrary deployed version be
    // confirmed whenever those defaults resolve — exactly the fail-open path
    // the acceptance criteria forbid. Empty/unresolved refs must fail closed.
    const calls: string[] = [];
    const result = await verifyReleaseComposition({
      releasePrefix: "1.6",
      deployedVersion: "myr-v1.6.8",
      members: [member("OPE-1", SHA_A)],
      resolvedRefs: [],
      fetchImpl: compareFake(["myr-v1.6"], [], calls),
      now: NOW,
    });
    expect(result.verdict).toBe("failed");
    expect(result.failureReason).toBe("deployed_version_unknown");
    expect(result.allMembersPresent).toBe(false);
    expect(result.reason).toMatch(/refs не разрешены/);
    // The guard short-circuits before any membership check.
    expect(calls).toHaveLength(0);
  });

  it("fails closed with deployed_version_unknown when resolvedRefs is omitted, even if membership would resolve present", async () => {
    // Same fail-open hole via the optional-field path: a caller that never
    // resolves refs has no proven mapping between the deployed version and a
    // real release ref, so confirmation is forbidden.
    const calls: string[] = [];
    const result = await verifyReleaseComposition({
      releasePrefix: "1.6",
      deployedVersion: "myr-v1.6.8",
      members: [member("OPE-1", SHA_A)],
      fetchImpl: compareFake(["myr-v1.6"], [], calls),
      now: NOW,
    });
    expect(result.verdict).toBe("failed");
    expect(result.failureReason).toBe("deployed_version_unknown");
    expect(result.allMembersPresent).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("fails with member_not_merged when a candidate PR is not merged, even if the rest resolve", async () => {
    // Review finding (PR #3093): the route used to drop unmerged candidates
    // from the set, so a release with one merged and one open PR could be
    // confirmed on the incomplete list. The full candidate set must include
    // the unmerged PR and fail the release, naming it.
    const calls: string[] = [];
    const result = await verifyReleaseComposition({
      releasePrefix: "1.6",
      deployedVersion: "myr-v1.6.8",
      members: [member("OPE-1", SHA_A, true), member("OPE-2", SHA_B, false)],
      resolvedRefs: [{ ref: "myr-v1.6.8", kind: "tag" }],
      fetchImpl: compareFake(["myr-v1.6.8"], [], calls),
      now: NOW,
    });
    expect(result.verdict).toBe("failed");
    expect(result.failureReason).toBe("member_not_merged");
    expect(result.reason).toContain("OPE-2");
    expect(result.allMembersPresent).toBe(false);
    // The unmerged member short-circuits before its membership is fetched;
    // the merged member may already have been checked.
    const unmergedCalls = calls.filter((c) => c.includes(SHA_B));
    expect(unmergedCalls).toHaveLength(0);
  });

  it("fails with member_not_merged when a draft PR is in the candidate set", async () => {
    const result = await verifyReleaseComposition({
      releasePrefix: "1.6",
      deployedVersion: "myr-v1.6.8",
      members: [member("OPE-9", null, false)],
      resolvedRefs: [{ ref: "myr-v1.6.8", kind: "tag" }],
      now: NOW,
    });
    expect(result.verdict).toBe("failed");
    expect(result.failureReason).toBe("member_not_merged");
  });

  it("keeps an unmerged candidate visible in members instead of dropping it", async () => {
    const result = await verifyReleaseComposition({
      releasePrefix: "1.6",
      deployedVersion: "myr-v1.6.8",
      members: [member("OPE-1", SHA_A, true), member("OPE-2", null, false)],
      resolvedRefs: [{ ref: "myr-v1.6.8", kind: "tag" }],
      fetchImpl: compareFake(["myr-v1.6.8"], [], []),
      now: NOW,
    });
    const unmerged = result.members.find((m) => m.id === "OPE-2");
    expect(unmerged).toBeDefined();
    expect(unmerged?.membership).toBe("unknown");
    expect(unmerged?.mergeCommitSha).toBeNull();
  });
});

describe("buildReleaseCandidateMembers", () => {
  const wp = (
    type: string,
    status: string,
    metadata: Record<string, unknown>,
  ): { type: string; status: string; metadata: Record<string, unknown> } => ({
    type,
    status,
    metadata,
  });

  it("includes every pull_request work product, merged or not", () => {
    const members = buildReleaseCandidateMembers([
      wp("pull_request", "merged", { repo: REPO, number: 1, mergeCommitSha: SHA_A }),
      wp("pull_request", "open", { repo: REPO, number: 2, mergeCommitSha: SHA_B }),
      wp("pull_request", "draft", { repo: REPO, number: 3 }),
    ]);
    expect(members).toHaveLength(3);
    expect(members[0]).toMatchObject({ id: "PR#1", merged: true, mergeCommitSha: SHA_A });
    expect(members[1]).toMatchObject({ id: "PR#2", merged: false, mergeCommitSha: SHA_B });
    expect(members[2]).toMatchObject({ id: "PR#3", merged: false, mergeCommitSha: null });
  });

  it("ignores non-pull_request work products", () => {
    const members = buildReleaseCandidateMembers([
      wp("preview_url", "running", { url: "https://example.test" }),
      wp("pull_request", "merged", { repo: REPO, number: 7, mergeCommitSha: SHA_A }),
    ]);
    expect(members).toHaveLength(1);
    expect(members[0].id).toBe("PR#7");
  });

  it("skips pull_request entries without a repository", () => {
    const members = buildReleaseCandidateMembers([
      wp("pull_request", "merged", { number: 5, mergeCommitSha: SHA_A }),
    ]);
    expect(members).toHaveLength(0);
  });
});
