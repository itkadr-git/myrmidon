import { describe, expect, it, vi } from "vitest";
import { verifyReleaseComposition, type ReleaseVerificationOptions } from "./release-verification.js";

const version = "myr-v1.7.0";
const sha = "aaa111aaa111aaa111aaa111aaa111aaa111aaa1";
const refs = [{ ref: version, kind: "tag" as const }];
const base = {
  releasePrefix: "1.7",
  members: [{ id: "PR#1", repository: "synthetic/release-fixture", mergeCommitSha: sha, merged: true }],
  now: () => new Date("2026-11-13T12:00:00.000Z"),
};

describe("verifyReleaseComposition version guard I/O", () => {
  const cases: { name: string; options: Partial<ReleaseVerificationOptions>; reason: string }[] = [
    { name: "omitted deployedVersion", options: { resolvedRefs: refs }, reason: "deployed_version_unknown" },
    { name: "null deployedVersion", options: { deployedVersion: null, resolvedRefs: refs }, reason: "deployed_version_unknown" },
    { name: "empty deployedVersion", options: { deployedVersion: "", resolvedRefs: refs }, reason: "deployed_version_unknown" },
    { name: "omitted resolvedRefs", options: { deployedVersion: version }, reason: "deployed_version_unknown" },
    { name: "empty resolvedRefs", options: { deployedVersion: version, resolvedRefs: [] }, reason: "deployed_version_unknown" },
    { name: "mismatched deployedVersion", options: { deployedVersion: "myr-v1.7.1", resolvedRefs: refs }, reason: "deployed_version_mismatch" },
  ];

  it.each(cases)("fails without fetching for $name", async ({ options, reason }) => {
    const fetchImpl = vi.fn(async () => { throw new Error("unexpected fetch"); });
    const result = await verifyReleaseComposition({ ...base, ...options, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.verdict).toBe("failed");
    expect(result.failureReason).toBe(reason);
    expect(result.allMembersPresent).toBe(false);
    expect(result.members).toEqual([]);
  });

  it("fetches and confirms a proven version with a present member", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: "identical", ahead_by: 0 }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const result = await verifyReleaseComposition({ ...base, deployedVersion: version, resolvedRefs: refs, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.verdict).toBe("confirmed");
    expect(result.failureReason).toBeNull();
    expect(result.allMembersPresent).toBe(true);
    expect(result.members).toEqual([{ id: "PR#1", repository: "synthetic/release-fixture", mergeCommitSha: sha, membership: "present", releaseRefs: [version] }]);
  });
});
