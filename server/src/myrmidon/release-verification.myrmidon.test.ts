import { describe, expect, it } from "vitest";

import {
  aggregateReleaseCandidates,
  buildReleaseCandidateMembers,
  composeReleaseVerdict,
  signReleaseVerificationVerdict,
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
    // 3 members × 1 deployed ref (myr-v1.6.8) = 3 calls. Membership is
    // checked against the exact ref the deployed version corresponds to,
    // not the whole release-line ref set (review finding PR #3093 round 4).
    expect(seen).toHaveLength(3);
    for (const url of seen) expect(url).toContain("compare/myr-v1.6.8...");
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

  it("fails when a candidate SHA exists only in a later release tag than the deployed one", async () => {
    // Review finding (PR #3093, round 4): the deployed version is validated
    // against the full resolved ref set, but membership must be proven against
    // the EXACT ref the deployed version corresponds to. If refs include both
    // myr-v1.8.0 and myr-v1.8.1, the deployed version is myr-v1.8.0, and a
    // candidate SHA exists only in myr-v1.8.1, the old code counted it present
    // (checked against ALL refs) and confirmed a release whose deployed build
    // omits that candidate.
    const calls: string[] = [];
    const resolvedRefs = [
      { ref: "myr-v1.8.0", kind: "tag" as const },
      { ref: "myr-v1.8.1", kind: "tag" as const },
    ];
    const result = await verifyReleaseComposition({
      releasePrefix: "1.8",
      deployedVersion: "myr-v1.8.0",
      members: [member("OPE-1", SHA_A), member("OPE-2", SHA_B)],
      resolvedRefs,
      fetchImpl: (input) => {
        calls.push(input);
        const url = new URL(input);
        const compareRef = decodeURIComponent(
          url.pathname.replace(/^\/repos\/[^/]+\/[^/]+\/compare\//, ""),
        );
        const base = compareRef.split("...")[0];
        // SHA_A is in myr-v1.8.0; SHA_B only landed in myr-v1.8.1.
        const sha = compareRef.split("...")[1];
        const present = base === "myr-v1.8.0" && sha === SHA_A;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () =>
            present ? { status: "identical", ahead_by: 0 } : { status: "diverged", ahead_by: 4 },
        } as unknown as Response);
      },
      now: NOW,
    });

    expect(result.verdict).toBe("failed");
    expect(result.failureReason).toBe("member_missing_from_release");
    expect(result.allMembersPresent).toBe(false);
    // Only the deployed ref (myr-v1.8.0) may be consulted — never the later tag.
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).toContain("compare/myr-v1.8.0...");
      expect(call).not.toContain("myr-v1.8.1");
    }
    const ope2 = result.members.find((m) => m.id === "OPE-2");
    expect(ope2?.membership).toBe("missing_from_release");
    expect(ope2?.releaseRefs).toEqual(["myr-v1.8.0"]);
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

  it("fails closed with member_metadata_incomplete when a candidate has no repository metadata", async () => {
    // Review finding (PR #3093): a pull_request work product without
    // metadata.repo used to be dropped by the builder, so a release whose
    // only candidate had incomplete metadata was reported as
    // empty_candidate_set — a generic message that hid the real gap. The
    // member must stay in the set and fail the release with a named reason,
    // even when every other signal would resolve as present.
    const calls: string[] = [];
    const result = await verifyReleaseComposition({
      releasePrefix: "1.6",
      deployedVersion: "myr-v1.6.8",
      members: [member("OPE-1", SHA_A, true), { ...member("OPE-2", SHA_B, true), repository: "" }],
      resolvedRefs: [{ ref: "myr-v1.6.8", kind: "tag" }],
      fetchImpl: compareFake(["myr-v1.6.8"], [], calls),
      now: NOW,
    });
    expect(result.verdict).toBe("failed");
    expect(result.failureReason).toBe("member_metadata_incomplete");
    expect(result.reason).toContain("OPE-2");
    expect(result.allMembersPresent).toBe(false);
    // Every member is listed, including the one with incomplete metadata,
    // so the persisted result shows the full unproven candidate set.
    expect(result.members).toHaveLength(2);
    const broken = result.members.find((m) => m.id === "OPE-2");
    expect(broken?.membership).toBe("unknown");
    expect(broken?.repository).toBe("");
    // No membership fetch is attempted for the broken member: without a repo
    // there is nothing to compare against.
    const brokenCalls = calls.filter((c) => c.includes(SHA_B));
    expect(brokenCalls).toHaveLength(0);
  });

  it("fails closed with member_metadata_incomplete when the ONLY candidate has no repository metadata", async () => {
    // The extreme case of the same hole: with the entry dropped the release
    // used to be reported as empty_candidate_set; now it is a named
    // metadata gap, not a generic empty-set message.
    const result = await verifyReleaseComposition({
      releasePrefix: "1.6",
      deployedVersion: "myr-v1.6.8",
      members: [{ ...member("OPE-9", SHA_A, true), repository: "" }],
      resolvedRefs: [{ ref: "myr-v1.6.8", kind: "tag" }],
      fetchImpl: compareFake(["myr-v1.6.8"], [], []),
      now: NOW,
    });
    expect(result.verdict).toBe("failed");
    expect(result.failureReason).toBe("member_metadata_incomplete");
    expect(result.failureReason).not.toBe("empty_candidate_set");
    expect(result.reason).toContain("OPE-9");
  });

  it("verifies the FULL release candidate set: one unmerged sibling fails the release even when the rest resolve", async () => {
    // Review finding (PR #3093): the route used to build the candidate set
    // from a single issue's work products. This scenario models the fixed
    // contract directly — the caller passes the aggregated full set — and
    // asserts the release fails while naming the unmerged sibling.
    const calls: string[] = [];
    const result = await verifyReleaseComposition({
      releasePrefix: "1.8",
      deployedVersion: "myr-v1.8.0",
      members: [
        member("OPE-A", SHA_A, true),
        member("OPE-B", SHA_B, true),
        member("OPE-C", SHA_C, false),
      ],
      resolvedRefs: [{ ref: "myr-v1.8.0", kind: "tag" }],
      fetchImpl: compareFake(["myr-v1.8.0"], [], calls),
      now: NOW,
    });
    expect(result.verdict).toBe("failed");
    expect(result.failureReason).toBe("member_not_merged");
    expect(result.reason).toContain("OPE-C");
    // All three candidates are visible in the persisted result.
    expect(result.members).toHaveLength(3);
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

  it("keeps pull_request entries without a repository as unverifiable members", () => {
    // Review finding (PR #3093): dropping the entry would let an incomplete
    // candidate list shrink and be reported as empty_candidate_set, hiding
    // the real gap. It must stay visible so the verification fails closed
    // with member_metadata_incomplete and names it.
    const members = buildReleaseCandidateMembers([
      wp("pull_request", "merged", { number: 5, mergeCommitSha: SHA_A }),
    ]);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ id: "PR#5", repository: "", merged: true, mergeCommitSha: SHA_A });
  });
});

describe("aggregateReleaseCandidates", () => {
  // End-to-end path of the VERIFY-ON-PROD route candidate-set assembly
  // (review finding PR #3093): the set must span EVERY issue of the release,
  // must keep unmerged siblings, and must keep entries with incomplete
  // metadata — so the verification fails closed on the full release instead
  // of confirming a partial list.
  const wp = (
    type: string,
    status: string,
    metadata: Record<string, unknown>,
  ): { type: string; status: string; metadata: Record<string, unknown> } => ({
    type,
    status,
    metadata,
  });

  it("collects pull_request candidates from every release issue, prefixing the owning issue", () => {
    const byIssue = new Map([
      ["OPE-1", [wp("pull_request", "merged", { repo: REPO, number: 1, mergeCommitSha: SHA_A })]],
      ["OPE-2", [
        wp("pull_request", "merged", { repo: REPO, number: 2, mergeCommitSha: SHA_B }),
        wp("preview_url", "running", { url: "https://example.test" }),
      ]],
    ]);
    const members = aggregateReleaseCandidates(byIssue);
    expect(members).toHaveLength(2);
    expect(members[0]).toMatchObject({ id: "OPE-1:PR#1", merged: true });
    expect(members[1]).toMatchObject({ id: "OPE-2:PR#2", merged: true });
  });

  it("keeps an unmerged sibling in the aggregated set so it fails the release", async () => {
    const byIssue = new Map([
      ["OPE-1", [wp("pull_request", "merged", { repo: REPO, number: 1, mergeCommitSha: SHA_A })]],
      ["OPE-2", [wp("pull_request", "open", { repo: REPO, number: 2, mergeCommitSha: SHA_B })]],
    ]);
    const members = aggregateReleaseCandidates(byIssue);
    expect(members).toHaveLength(2);

    const result = await verifyReleaseComposition({
      releasePrefix: "1.8",
      deployedVersion: "myr-v1.8.0",
      members,
      resolvedRefs: [{ ref: "myr-v1.8.0", kind: "tag" }],
      fetchImpl: compareFake(["myr-v1.8.0"], [], []),
      now: NOW,
    });
    expect(result.verdict).toBe("failed");
    expect(result.failureReason).toBe("member_not_merged");
    expect(result.reason).toContain("OPE-2:PR#2");
  });

  it("keeps incomplete-metadata entries from any release issue in the aggregated set", async () => {
    const byIssue = new Map([
      ["OPE-1", [wp("pull_request", "merged", { repo: REPO, number: 1, mergeCommitSha: SHA_A })]],
      ["OPE-2", [wp("pull_request", "merged", { number: 3, mergeCommitSha: SHA_C })]],
    ]);
    const members = aggregateReleaseCandidates(byIssue);
    expect(members).toHaveLength(2);

    const result = await verifyReleaseComposition({
      releasePrefix: "1.8",
      deployedVersion: "myr-v1.8.0",
      members,
      resolvedRefs: [{ ref: "myr-v1.8.0", kind: "tag" }],
      fetchImpl: compareFake(["myr-v1.8.0"], [], []),
      now: NOW,
    });
    expect(result.verdict).toBe("failed");
    expect(result.failureReason).toBe("member_metadata_incomplete");
    expect(result.reason).toContain("OPE-2:PR#3");
  });
});

describe("signReleaseVerificationVerdict (OPE-13017)", () => {
  // The publisher (scripts/myrmidon/release/publish-github-release.sh)
  // verifies HMAC-SHA256 over the canonical string
  //   verdict|deployedVersion|checkedAt|issueId
  // keyed with MYRMIDON_RELEASE_VERIFICATION_KEY. These vectors pin the
  // canonical format and prove the signature is stable and key-dependent
  // (a different key or field set must not verify).
  const KEY = "test-verification-key";
  const KEY_OTHER = "other-key";
  const INPUT = {
    verdict: "confirmed",
    deployedVersion: "abc123abc123abc123abc123abc123abc123abc1",
    checkedAt: "2026-11-14T04:00:00.000Z",
    issueId: "5f38f2aa-381b-476c-97a8-d8ba190c099b",
  };

  it("produces a deterministic HMAC-SHA256 hex signature", () => {
    const sig = signReleaseVerificationVerdict(INPUT, KEY);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(signReleaseVerificationVerdict(INPUT, KEY)).toBe(sig);
  });

  it("matches an independent openssl computation of the canonical string", async () => {
    const { createHmac } = await import("node:crypto");
    const canonical = `${INPUT.verdict}|${INPUT.deployedVersion}|${INPUT.checkedAt}|${INPUT.issueId}`;
    const expected = createHmac("sha256", KEY).update(canonical).digest("hex");
    expect(signReleaseVerificationVerdict(INPUT, KEY)).toBe(expected);
  });

  it("differs when any canonical field changes", () => {
    const base = signReleaseVerificationVerdict(INPUT, KEY);
    expect(signReleaseVerificationVerdict({ ...INPUT, verdict: "failed" }, KEY)).not.toBe(base);
    expect(
      signReleaseVerificationVerdict({ ...INPUT, deployedVersion: "deadbeef" }, KEY),
    ).not.toBe(base);
    expect(signReleaseVerificationVerdict({ ...INPUT, checkedAt: "2026-11-15T00:00:00.000Z" }, KEY)).not.toBe(base);
    expect(
      signReleaseVerificationVerdict({ ...INPUT, issueId: "other-issue" }, KEY),
    ).not.toBe(base);
  });

  it("differs when the key differs", () => {
    expect(signReleaseVerificationVerdict(INPUT, KEY_OTHER)).not.toBe(
      signReleaseVerificationVerdict(INPUT, KEY),
    );
  });

  it("normalises a null deployedVersion to the empty field", async () => {
    const { createHmac } = await import("node:crypto");
    const canonical = `${INPUT.verdict}||${INPUT.checkedAt}|${INPUT.issueId}`;
    const expected = createHmac("sha256", KEY).update(canonical).digest("hex");
    expect(
      signReleaseVerificationVerdict({ ...INPUT, deployedVersion: null }, KEY),
    ).toBe(expected);
  });
});
