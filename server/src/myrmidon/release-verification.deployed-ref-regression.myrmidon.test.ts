import { describe, expect, it } from "vitest";

import { verifyReleaseComposition, type ReleaseCandidateMember } from "./release-verification.js";

const REPOSITORY = "acme/project";
const MERGE_SHA = "aaa111aaa111aaa111aaa111aaa111aaa111aaa1";
const BASE_REF = "myr-v1.7.0";
const RC_REF = "myr-v1.7.0-rc.1";
const LATER_REF = "myr-v1.7.1";

function member(): ReleaseCandidateMember {
  return {
    id: "OPE-13334",
    repository: REPOSITORY,
    mergeCommitSha: MERGE_SHA,
    merged: true,
  };
}

function compareFake(calls: string[]): (input: string, init?: RequestInit) => Promise<Response> {
  return (input: string) => {
    calls.push(input);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ status: "identical", ahead_by: 0 }),
    } as unknown as Response);
  };
}

function compareRefs(calls: readonly string[]): string[] {
  return calls.map((call) => {
    const url = new URL(call);
    const compareRef = decodeURIComponent(url.pathname.split("/compare/")[1] ?? "");
    return compareRef.split("...")[0];
  });
}

describe("deployed ref selection regression", () => {
  it("uses the exact RC ref instead of the shorter base tag in either ref order", async () => {
    for (const resolvedRefs of [
      [
        { ref: BASE_REF, kind: "tag" as const },
        { ref: RC_REF, kind: "tag" as const },
      ],
      [
        { ref: RC_REF, kind: "tag" as const },
        { ref: BASE_REF, kind: "tag" as const },
      ],
    ]) {
      const calls: string[] = [];
      const result = await verifyReleaseComposition({
        releasePrefix: "1.7",
        deployedVersion: RC_REF,
        members: [member()],
        resolvedRefs,
        fetchImpl: compareFake(calls),
      });

      expect(result.verdict).toBe("confirmed");
      expect(result.members).toEqual([
        expect.objectContaining({
          id: "OPE-13334",
          membership: "present",
          releaseRefs: [RC_REF],
        }),
      ]);
      expect(compareRefs(calls)).toEqual([RC_REF]);
    }
  });

  it("uses the longest matching ref for git-describe output, independent of ref order", async () => {
    for (const resolvedRefs of [
      [
        { ref: BASE_REF, kind: "tag" as const },
        { ref: RC_REF, kind: "tag" as const },
        { ref: LATER_REF, kind: "tag" as const },
      ],
      [
        { ref: LATER_REF, kind: "tag" as const },
        { ref: RC_REF, kind: "tag" as const },
        { ref: BASE_REF, kind: "tag" as const },
      ],
    ]) {
      const calls: string[] = [];
      const members = [member()];
      const beforeRefs = structuredClone(resolvedRefs);
      const beforeMembers = structuredClone(members);
      const result = await verifyReleaseComposition({
        releasePrefix: "1.7",
        deployedVersion: `${RC_REF}-15-g4c55f0d`,
        members,
        resolvedRefs,
        fetchImpl: compareFake(calls),
      });

      expect(result.verdict).toBe("confirmed");
      expect(result.members[0]?.membership).toBe("present");
      expect(resolvedRefs).toEqual(beforeRefs);
      expect(members).toEqual(beforeMembers);
      expect(result.members[0]?.releaseRefs).toEqual([RC_REF]);
      expect(compareRefs(calls)).toEqual([RC_REF]);
      expect(compareRefs(calls)).not.toContain(BASE_REF);
      expect(compareRefs(calls)).not.toContain(LATER_REF);
    }
  });

  it("does not let a later tag confirm a member missing from the deployed RC", async () => {
    const calls: string[] = [];
    const result = await verifyReleaseComposition({
      releasePrefix: "1.7",
      deployedVersion: RC_REF,
      members: [member()],
      resolvedRefs: [
        { ref: BASE_REF, kind: "tag" },
        { ref: RC_REF, kind: "tag" },
        { ref: LATER_REF, kind: "tag" },
      ],
      fetchImpl: (input) => {
        calls.push(input);
        const isLater = compareRefs([input])[0] === LATER_REF;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => isLater
            ? { status: "identical", ahead_by: 0 }
            : { status: "diverged", ahead_by: 3 },
        } as unknown as Response);
      },
    });
    expect(result.verdict).toBe("failed");
    expect(result.failureReason).toBe("member_missing_from_release");
    expect(result.members[0]).toEqual(expect.objectContaining({ membership: "missing_from_release", releaseRefs: [RC_REF] }));
    expect(compareRefs(calls)).toEqual([RC_REF]);
  });

  it("does not confirm an unknown membership", async () => {
    const calls: string[] = [];
    const result = await verifyReleaseComposition({
      releasePrefix: "1.7",
      deployedVersion: RC_REF,
      members: [member()],
      resolvedRefs: [{ ref: RC_REF, kind: "tag" }],
      fetchImpl: (input) => {
        calls.push(input);
        return Promise.resolve({ ok: false, status: 404 } as Response);
      },
    });
    expect(result.verdict).toBe("failed");
    expect(result.failureReason).toBe("deployed_version_unknown");
    expect(result.members[0]).toEqual(expect.objectContaining({ membership: "unknown", releaseRefs: [RC_REF] }));
    expect(compareRefs(calls)).toEqual([RC_REF]);
  });

  it("fails closed for an absent deployed version without checking any ref", async () => {
    const calls: string[] = [];
    const resolvedRefs = [
      { ref: BASE_REF, kind: "tag" as const },
      { ref: RC_REF, kind: "tag" as const },
    ];
    const result = await verifyReleaseComposition({
      releasePrefix: "1.7",
      deployedVersion: null,
      members: [member()],
      resolvedRefs,
      fetchImpl: compareFake(calls),
    });

    expect(result.verdict).toBe("failed");
    expect(result.failureReason).toBe("deployed_version_unknown");
    expect(result.members).toEqual([]);
    expect(calls).toEqual([]);
  });
});
