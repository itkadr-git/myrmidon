import { describe, expect, it } from "vitest";

import { composeReleaseVerdict, verifyReleaseComposition } from "./release-verification.js";
import type { ReleaseMembershipVerdict } from "./release-membership.js";

const values: ReleaseMembershipVerdict[] = ["present", "missing_from_release", "unknown"];
const ref = "myr-v1.7.0";
const checkedAt = "2026-11-13T12:00:00.000Z";

function arrays(length: number): ReleaseMembershipVerdict[][] {
  if (length === 0) return [[]];
  return arrays(length - 1).flatMap((prefix) => values.map((value) => [...prefix, value]));
}

const cases = Array.from({ length: 5 }, (_, length) => arrays(length)).flat();

function oracle(memberships: readonly ReleaseMembershipVerdict[]) {
  if (memberships.length === 0) return { verdict: "failed", failureReason: "empty_candidate_set" };
  if (memberships.includes("unknown")) return { verdict: "failed", failureReason: "deployed_version_unknown" };
  if (memberships.includes("missing_from_release")) return { verdict: "failed", failureReason: "member_missing_from_release" };
  return { verdict: "confirmed", failureReason: null };
}

describe("release verdict lattice", () => {
  it.each(cases.map((memberships) => [memberships] as const))(
    "composes and verifies the ordered memberships %j",
    async (memberships) => {
      const expected = oracle(memberships);
      const direct = composeReleaseVerdict(memberships);
      expect(direct).toMatchObject(expected);

      const members = memberships.map((_, index) => ({
        id: `candidate-${index}`,
        repository: "synthetic/release-fixture",
        mergeCommitSha: (index + 1).toString(16).padStart(40, "0"),
        merged: true,
      }));
      const calls: string[] = [];
      const result = await verifyReleaseComposition({
        releasePrefix: "1.7",
        deployedVersion: ref,
        resolvedRefs: [{ ref, kind: "tag" }],
        members,
        now: () => new Date(checkedAt),
        fetchImpl: async (input) => {
          calls.push(input);
          const sha = new URL(input).pathname.split("...")[1];
          const index = members.findIndex((member) => member.mergeCommitSha === sha);
          if (index < 0) return new Response(null, { status: 500 });
          const membership = memberships[index];
          if (membership === "unknown") return new Response(null, { status: 404 });
          return Response.json(membership === "present"
            ? { status: "identical", ahead_by: 0 }
            : { status: "diverged", ahead_by: 3 });
        },
      });

      expect(result).toMatchObject({
        ...expected,
        releasePrefix: "1.7",
        deployedVersion: ref,
        checkedAt,
        allMembersPresent: expected.verdict === "confirmed",
        members: members.map((member, index) => ({
          id: member.id,
          repository: member.repository,
          mergeCommitSha: member.mergeCommitSha,
          membership: memberships[index],
          releaseRefs: [ref],
        })),
      });
      expect(calls).toEqual(members.map((member) =>
        `https://api.github.com/repos/synthetic/release-fixture/compare/${ref}...${member.mergeCommitSha}`,
      ));
      expect(result.reason).toBe(direct.reason);
      const unknownCount = memberships.filter((membership) => membership === "unknown").length;
      const missingCount = memberships.filter((membership) => membership === "missing_from_release").length;
      if (unknownCount > 0) {
        expect(direct.reason).toContain(`${unknownCount} из ${memberships.length}`);
      } else if (missingCount > 0) {
        expect(direct.reason).toContain(`${missingCount} из ${memberships.length}`);
      } else if (memberships.length > 0) {
        expect(direct.reason).toContain(`${memberships.length}`);
      }
    },
  );
});
