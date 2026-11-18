import { describe, expect, it } from "vitest";
import { verifyReleaseComposition, type ReleaseCandidateMember } from "./release-verification.js";

const REPOSITORY = "synthetic/release-fixture";
const VERSION = "myr-v1.7.0";
const UNKNOWN_SHA = "a".repeat(40);
const MISSING_SHA = "b".repeat(40);
const now = () => new Date("2026-11-13T12:00:00.000Z");

const member = (id: string, sha: string | null, merged = true): ReleaseCandidateMember => ({
  id, repository: REPOSITORY, mergeCommitSha: sha, merged,
});

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length === 0) return [[]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
  );
}

const metadata = { ...member("metadata", UNKNOWN_SHA), repository: "" };
const unmerged = member("unmerged", null, false);
const noSha = member("no-sha", null);
const unknown = member("unknown", UNKNOWN_SHA);
const missing = member("missing", MISSING_SHA);

const scenarios = [
  { name: "metadata before unmerged and missing SHA", members: [metadata, unmerged, noSha], failure: "member_metadata_incomplete", named: "metadata", calls: [] },
  { name: "unmerged before missing SHA and unknown compare", members: [unmerged, noSha, unknown], failure: "member_not_merged", named: "unmerged", calls: [UNKNOWN_SHA] },
  { name: "missing SHA before missing compare", members: [noSha, missing], failure: "member_sha_missing", named: "no-sha", calls: [MISSING_SHA] },
  { name: "unknown compare before missing compare", members: [unknown, missing], failure: "deployed_version_unknown", named: null, calls: [UNKNOWN_SHA, MISSING_SHA] },
] as const;

describe("verifyReleaseComposition mixed failure precedence", () => {
  for (const scenario of scenarios) {
    it(scenario.name + " regardless of member order", async () => {
      for (const members of permutations(scenario.members)) {
        const calls: string[] = [];
        const result = await verifyReleaseComposition({
          releasePrefix: "1.7",
          deployedVersion: VERSION,
          resolvedRefs: [{ ref: VERSION, kind: "tag" }],
          members,
          now,
          fetchImpl: async (input) => {
            const url = new URL(input);
            const compare = decodeURIComponent(url.pathname);
            expect(compare.startsWith(`/repos/${REPOSITORY}/compare/${VERSION}...`)).toBe(true);
            const sha = compare.split("...")[1];
            calls.push(sha);
            if (sha === UNKNOWN_SHA) return new Response("{}", { status: 404 });
            expect(sha).toBe(MISSING_SHA);
            return new Response(JSON.stringify({ status: "diverged", ahead_by: 3 }), { status: 200 });
          },
        });
        expect(result.verdict).toBe("failed");
        expect(result.failureReason).toBe(scenario.failure);
        expect(result.allMembersPresent).toBe(false);
        expect(result.checkedAt).toBe("2026-11-13T12:00:00.000Z");
        expect(result.members.map((entry) => entry.id)).toEqual(members.map((entry) => entry.id));
        if (scenario.named) expect(result.reason).toContain(scenario.named);
        expect(calls.sort()).toEqual([...scenario.calls].sort());
        if ((scenario.calls as readonly string[]).includes(UNKNOWN_SHA)) {
          expect(result.members.find((entry) => entry.id === "unknown")?.membership).toBe("unknown");
        }
        if ((scenario.calls as readonly string[]).includes(MISSING_SHA)) {
          expect(result.members.find((entry) => entry.id === "missing")?.membership).toBe("missing_from_release");
        }
      }
    });
  }
});
