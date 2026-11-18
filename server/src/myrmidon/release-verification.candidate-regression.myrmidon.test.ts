import { describe, expect, it } from "vitest";
import {
  aggregateReleaseCandidates,
  composeReleaseVerdict,
  verifyReleaseComposition,
} from "./release-verification.js";

describe("release candidate aggregation regression", () => {
  it("preserves every owner and candidate in Map order without mutating frozen inputs", () => {
    const first = Object.freeze([
      Object.freeze({ type: "pull_request", status: "merged", metadata: Object.freeze({ repo: "alpha/app", number: 42, mergeCommitSha: "a".repeat(40), nested: Object.freeze({ labels: Object.freeze(["release"]) }) }) }),
      Object.freeze({ type: "branch", status: "active", metadata: Object.freeze({ repo: "alpha/app", number: 99 }) }),
      Object.freeze({ type: "pull_request", status: "open", metadata: Object.freeze({ repo: "alpha/app", number: 7 }) }),
    ]);
    const empty = Object.freeze([]);
    const last = Object.freeze([
      Object.freeze({ type: "artifact", status: "ready", metadata: Object.freeze({ repo: "beta/app", number: 100 }) }),
      Object.freeze({ type: "pull_request", status: "merged", metadata: Object.freeze({ repo: "alpha/app", number: 42, mergeCommitSha: "a".repeat(40) }) }),
      Object.freeze({ type: "pull_request", status: "merged", metadata: Object.freeze({ repo: "beta/app", number: 42, mergeCommitSha: "b".repeat(40) }) }),
      Object.freeze({ type: "pull_request", status: "merged", metadata: Object.freeze({ number: 8, mergeCommitSha: "c".repeat(40) }) }),
      Object.freeze({ type: "pull_request", status: "draft" }),
    ]);
    type WorkProduct = { type: string; status: string; metadata?: unknown };
    const input = new Map<string, readonly WorkProduct[]>([["OPE-2", first], ["OPE-empty", empty], ["OPE-1", last]]);
    const snapshot = structuredClone([...input]);
    const expected = [
      { id: "OPE-2:PR#42", repository: "alpha/app", mergeCommitSha: "a".repeat(40), merged: true },
      { id: "OPE-2:PR#7", repository: "alpha/app", mergeCommitSha: null, merged: false },
      { id: "OPE-1:PR#42", repository: "alpha/app", mergeCommitSha: "a".repeat(40), merged: true },
      { id: "OPE-1:PR#42", repository: "beta/app", mergeCommitSha: "b".repeat(40), merged: true },
      { id: "OPE-1:PR#8", repository: "", mergeCommitSha: "c".repeat(40), merged: true },
      { id: "OPE-1:PR#?", repository: "", mergeCommitSha: null, merged: false },
    ];

    expect(aggregateReleaseCandidates(input)).toEqual(expected);
    expect(aggregateReleaseCandidates(input)).toEqual(expected);
    expect([...input]).toEqual(snapshot);
    expect(aggregateReleaseCandidates(new Map<string, readonly WorkProduct[]>([["OPE-1", last], ["OPE-empty", empty], ["OPE-2", first]])))
      .toEqual([...expected.slice(2), ...expected.slice(0, 2)]);
  });

  it("fails closed when an aggregated candidate has incomplete metadata", async () => {
    const members = aggregateReleaseCandidates(new Map([
      ["OPE-1", [{ type: "pull_request", status: "merged", metadata: { number: 42, mergeCommitSha: "a".repeat(40) } }]],
    ]));
    const result = await verifyReleaseComposition({
      releasePrefix: "1.7",
      deployedVersion: "myr-v1.7.0",
      resolvedRefs: [{ ref: "myr-v1.7.0", kind: "tag" }],
      members,
      fetchImpl: () => { throw new Error("unexpected network access"); },
    });
    expect(result.verdict).toBe("failed");
    expect(result.failureReason).toBe("member_metadata_incomplete");
    expect(result.allMembersPresent).toBe(false);
    expect(result.members.map(({ id, membership }) => ({ id, membership }))).toEqual([
      { id: "OPE-1:PR#42", membership: "unknown" },
    ]);
    expect(composeReleaseVerdict(["present", "unknown"]).verdict).toBe("failed");
  });
});
