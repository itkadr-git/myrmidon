import { describe, expect, it } from "vitest";

import {
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

function member(id: string, sha: string | null): ReleaseCandidateMember {
  return { id, repository: REPO, mergeCommitSha: sha };
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
      fetchImpl: compareFake(["myr-v1.6"], [], calls),
      now: NOW,
    });

    expect(result.verdict).toBe("confirmed");
    expect(result.failureReason).toBeNull();
    expect(result.allMembersPresent).toBe(true);
    expect(result.members).toHaveLength(2);
    expect(result.members.every((m) => m.membership === "present")).toBe(true);
    expect(result.checkedAt).toBe("2026-11-13T12:00:00.000Z");
    // Both members were actually checked against the release contract.
    // Each member is checked against the two default release refs
    // (myr-v<prefix> tag and rel/<prefix>-fixes branch), so 2 members × 2 refs = 4 calls.
    expect(calls.length).toBe(4);
  });

  it("fails the release with a reason when one member is missing", async () => {
    const result = await verifyReleaseComposition({
      releasePrefix: "1.6",
      deployedVersion: "myr-v1.6.8",
      members: [member("OPE-1", SHA_A), member("OPE-2", SHA_B)],
      fetchImpl: compareFake(["myr-v1.6"], [], []),
      now: NOW,
    });

    // Make the second member missing by pointing the fake the other way.
    const failing = await verifyReleaseComposition({
      releasePrefix: "1.6",
      deployedVersion: "myr-v1.6.8",
      members: [member("OPE-1", SHA_A), member("OPE-2", SHA_B)],
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
      fetchImpl: compareFake(["myr-v1.6"], [], []),
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

  it("checks every member against the release line, not just the first", async () => {
    const seen: string[] = [];
    await verifyReleaseComposition({
      releasePrefix: "1.6",
      members: [member("OPE-1", SHA_A), member("OPE-2", SHA_B), member("OPE-3", SHA_C)],
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
});
