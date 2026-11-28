import { describe, expect, it } from "vitest";
import { verifyReleaseComposition } from "./release-verification.js";

const tag = "myr-v1.8.0";
const shaA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const shaB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const member = (repository: string, sha: string) => ({ id: repository, repository, mergeCommitSha: sha, merged: true });

describe("release verification repository scope", () => {
  it.each(["same tag with different contents", "tag missing"]) (
    "does not confirm a second repository without its own resolved ref: %s",
    async (scenario) => {
      const calls: string[] = [];
      const result = await verifyReleaseComposition({
        releasePrefix: "1.8", deployedVersion: tag,
        members: [member("acme/primary", shaA), member("acme/other", shaB)],
        resolvedRefs: [{ ref: tag, kind: "tag" }],
        fetchImpl: async (input) => {
          calls.push(input);
          if (input.includes("/acme/other/") && scenario === "tag missing") {
            return new Response("{}", { status: 404 });
          }
          return Response.json({ status: "identical", ahead_by: 0 });
        },
      });
      expect(result.verdict).toBe("failed");
      expect(result.allMembersPresent).toBe(false);
      expect(result.members[0]?.membership).toBe("present");
      expect(result.members[0]?.releaseRefs).toEqual([tag]);
      expect(result.members[1]?.membership).toBe("unknown");
      expect(result.members[1]?.releaseRefs).toEqual([]);
      expect(calls.some((url) => url.includes("/acme/primary/"))).toBe(true);
      expect(calls.some((url) => url.includes("/acme/other/"))).toBe(false);
    },
  );

  it("confirms a single repository against the exact deployed ref", async () => {
    const calls: string[] = [];
    const result = await verifyReleaseComposition({
      releasePrefix: "1.8", deployedVersion: tag,
      members: [member("acme/primary", shaA)],
      resolvedRefs: [{ ref: tag, kind: "tag" }, { ref: "myr-v1.8.1", kind: "tag" }],
      fetchImpl: async (input) => { calls.push(input); return Response.json({ status: "identical", ahead_by: 0 }); },
    });
    expect(result.verdict).toBe("confirmed");
    expect(result.members[0]?.releaseRefs).toEqual([tag]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`compare/${tag}...${shaA}`);
  });
});
