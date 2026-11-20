import { describe, expect, it, vi } from "vitest";
import { verifyReleaseComposition, type ReleaseVerificationOptions } from "./release-verification.js";

const repo = "synthetic/release-fixture";
const sha = "aaa111aaa111aaa111aaa111aaa111aaa111aaa1";
const tag = "myr-v1.7.0";
const firstDate = "2026-11-13T12:00:00.000Z";
const secondDate = "2026-11-14T12:00:00.000Z";
const member = { id: "candidate-1", repository: repo, mergeCommitSha: sha, merged: true };
const refs = [{ ref: tag, kind: "tag" as const }];
const unknownMember = { id: member.id, repository: repo, mergeCommitSha: sha, membership: "unknown", releaseRefs: [] };

const cases: {
  name: string;
  overrides: Partial<ReleaseVerificationOptions>;
  verdict: "confirmed" | "failed";
  failureReason: string | null;
  expectedMembers: object[];
  compare: "present" | "missing";
  fetchCount: number;
}[] = [
  { name: "confirmed", overrides: {}, verdict: "confirmed", failureReason: null,
    expectedMembers: [{ id: member.id, repository: repo, mergeCommitSha: sha, membership: "present", releaseRefs: [tag] }], compare: "present", fetchCount: 1 },
  { name: "unknown version", overrides: { deployedVersion: null }, verdict: "failed", failureReason: "deployed_version_unknown", expectedMembers: [], compare: "present", fetchCount: 0 },
  { name: "mismatched version", overrides: { deployedVersion: "myr-v1.8.0" }, verdict: "failed", failureReason: "deployed_version_mismatch", expectedMembers: [], compare: "present", fetchCount: 0 },
  { name: "empty candidates", overrides: { members: [] }, verdict: "failed", failureReason: "empty_candidate_set", expectedMembers: [], compare: "present", fetchCount: 0 },
  { name: "incomplete metadata", overrides: { members: [{ ...member, repository: "" }] }, verdict: "failed", failureReason: "member_metadata_incomplete", expectedMembers: [{ ...unknownMember, repository: "" }], compare: "present", fetchCount: 0 },
  { name: "not merged", overrides: { members: [{ ...member, merged: false }] }, verdict: "failed", failureReason: "member_not_merged", expectedMembers: [unknownMember], compare: "present", fetchCount: 0 },
  { name: "missing SHA", overrides: { members: [{ ...member, mergeCommitSha: null }] }, verdict: "failed", failureReason: "member_sha_missing", expectedMembers: [{ ...unknownMember, mergeCommitSha: null }], compare: "present", fetchCount: 0 },
  { name: "missing membership", overrides: {}, verdict: "failed", failureReason: "member_missing_from_release",
    expectedMembers: [{ id: member.id, repository: repo, mergeCommitSha: sha, membership: "missing_from_release", releaseRefs: [tag] }], compare: "missing", fetchCount: 1 },
];

describe("verifyReleaseComposition checkedAt clock", () => {
  it.each(cases)("reads the clock once per verification: $name", async (scenario) => {
    const now = vi.fn()
      .mockImplementationOnce(() => new Date(firstDate))
      .mockImplementationOnce(() => new Date(secondDate))
      .mockImplementation(() => new Date("2030-01-01T00:00:00.000Z"));
    const fetchImpl = vi.fn(async (input: string) => {
      expect(input).toBe(`https://api.github.com/repos/${repo}/compare/${tag}...${sha}`);
      const body = scenario.compare === "present"
        ? { status: "identical", ahead_by: 0 }
        : { status: "diverged", ahead_by: 3 };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    const options: ReleaseVerificationOptions = {
      releasePrefix: "1.7", deployedVersion: tag, members: [member], resolvedRefs: refs,
      fetchImpl, now, ...scenario.overrides,
    };
    const first = await verifyReleaseComposition(options);
    expect(now).toHaveBeenCalledTimes(1);
    expect.soft(first.checkedAt).toBe(firstDate);
    expect(first.verdict).toBe(scenario.verdict);
    expect(first.failureReason).toBe(scenario.failureReason);
    expect(first.allMembersPresent).toBe(scenario.verdict === "confirmed");
    expect(first.members).toEqual(scenario.expectedMembers);
    expect(fetchImpl).toHaveBeenCalledTimes(scenario.fetchCount);
    const firstSnapshot = structuredClone(first);

    const second = await verifyReleaseComposition(options);
    expect(now).toHaveBeenCalledTimes(2);
    expect(second.checkedAt).toBe(secondDate);
    expect(second.verdict).toBe(scenario.verdict);
    expect(second.failureReason).toBe(scenario.failureReason);
    expect(second.allMembersPresent).toBe(scenario.verdict === "confirmed");
    expect(second.members).toEqual(scenario.expectedMembers);
    expect(fetchImpl).toHaveBeenCalledTimes(2 * scenario.fetchCount);
    expect(first).toEqual(firstSnapshot);
    expect.soft(first.checkedAt).toBe(firstDate);
  });
});
