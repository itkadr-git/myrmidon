import { describe, expect, it } from "vitest";
import { approvedPrSince, buildDevflowSignals, extractPrNumber, redCiSince } from "./signals.js";

const now = new Date("2026-10-27T20:00:00Z");

describe("DEVFLOW runtime signals", () => {
  it("delivers a company-scoped deterministic alert only at the threshold", () => {
    const sample = {
      companyId: "company-a",
      subjectId: "issue-a",
      subjectKind: "issue" as const,
      title: "Review",
      metric: "reviewQueueAgeMs" as const,
      since: "2026-10-27T19:59:00Z",
    };
    expect(buildDevflowSignals([sample], { reviewQueueAgeMs: 60_001 }, now)).toEqual([]);
    expect(buildDevflowSignals([sample], { reviewQueueAgeMs: 60_000 }, now)).toMatchObject([
      { companyId: "company-a", subjectId: "issue-a", durationMs: 60_000, dedupKey: "devflow:company-a:reviewQueueAgeMs:issue-a" },
    ]);
  });

  it("delivers approvedNotMergedMs alerts when duration meets threshold", () => {
    const sample = {
      companyId: "company-a",
      subjectId: "issue-b",
      subjectKind: "issue" as const,
      title: "Task with approved PR",
      metric: "approvedNotMergedMs" as const,
      since: "2026-10-27T18:00:00Z",
    };
    expect(buildDevflowSignals([sample], { approvedNotMergedMs: 7_200_001 }, now)).toEqual([]);
    expect(buildDevflowSignals([sample], { approvedNotMergedMs: 7_200_000 }, now)).toMatchObject([
      { companyId: "company-a", subjectId: "issue-b", durationMs: 7_200_000, dedupKey: "devflow:company-a:approvedNotMergedMs:issue-b" },
    ]);
  });

  it("delivers noMergesMs alerts when 0 merges in 6 hours with active queue", () => {
    const sample = {
      companyId: "company-a",
      subjectId: "issue-c",
      subjectKind: "issue" as const,
      title: "Devflow merge queue stalled: 0 merges in 6h (2 active PRs)",
      metric: "noMergesMs" as const,
      since: "2026-10-27T14:00:00Z",
    };
    expect(buildDevflowSignals([sample], { noMergesMs: 21_600_001 }, now)).toEqual([]);
    expect(buildDevflowSignals([sample], { noMergesMs: 21_600_000 }, now)).toMatchObject([
      { companyId: "company-a", subjectId: "issue-c", durationMs: 21_600_000, dedupKey: "devflow:company-a:noMergesMs:issue-c" },
    ]);
  });

  it("preserves the first failure until a successful completion, ignoring reruns in progress", () => {
    expect(redCiSince([
      { conclusion: "failure", at: "2026-10-27T18:00:00Z" },
      { conclusion: "failure", at: "2026-10-27T19:00:00Z" },
      { conclusion: null, at: "2026-10-27T19:30:00Z" },
    ])).toBe("2026-10-27T18:00:00Z");
    expect(redCiSince([
      { conclusion: "success", at: "2026-10-27T19:00:00Z" },
      { conclusion: "failure", at: "2026-10-27T18:00:00Z" },
    ])).toBeNull();
  });

  it("does not turn cancelled/skipped/invalid events into red CI", () => {
    expect(redCiSince([
      { conclusion: "cancelled", at: now.toISOString() },
      { conclusion: "failure", at: "invalid" },
    ])).toBeNull();
  });

  describe("extractPrNumber", () => {
    it("extracts from metadata.number, metadata.prNumber, product.externalId, or url", () => {
      expect(extractPrNumber({ status: "open", metadata: { number: 101 } })).toBe(101);
      expect(extractPrNumber({ status: "open", metadata: { prNumber: 102 } })).toBe(102);
      expect(extractPrNumber({ status: "open", metadata: { pullRequestNumber: 103 } })).toBe(103);
      expect(extractPrNumber({ status: "open", externalId: "104" })).toBe(104);
      expect(extractPrNumber({ status: "open", externalId: 105 })).toBe(105);
      expect(extractPrNumber({ status: "open", url: "https://github.com/itkadr-git/myrmidon/pull/106" })).toBe(106);
      expect(extractPrNumber({ status: "open", metadata: {} })).toBeNull();
    });
  });

  describe("approvedPrSince", () => {
    it("returns null for merged or closed PRs", () => {
      expect(approvedPrSince({ status: "merged", reviewState: "approved" })).toBeNull();
      expect(approvedPrSince({ status: "closed", reviewState: "approved" })).toBeNull();
    });

    it("detects approval from product reviewState with stable createdAt / fallback", () => {
      const createdAt = new Date("2026-10-27T18:00:00Z");
      expect(approvedPrSince({ status: "open", reviewState: "approved", createdAt })).toBe("2026-10-27T18:00:00.000Z");
    });

    it("detects approval from metadata reviewApproved / labels", () => {
      const createdAt = new Date("2026-10-27T17:30:00Z");
      expect(approvedPrSince({ status: "open", metadata: { reviewApproved: true }, createdAt })).toBe("2026-10-27T17:30:00.000Z");
      expect(approvedPrSince({ status: "open", metadata: { labels: ["review-approved"] }, createdAt })).toBe("2026-10-27T17:30:00.000Z");
      expect(approvedPrSince({ status: "open", metadata: { reviewApprovedAt: "2026-10-27T16:00:00.000Z" } })).toBe("2026-10-27T16:00:00.000Z");
    });

    it("detects approval from canonical review header ^APPROVE PR #N sha", () => {
      const product = {
        status: "open",
        metadata: { number: 1986, headSha: "eb7e5cec37ed6bd3b307e180c3d107c6586c8cc3" },
      };
      const comments = [
        {
          body: "APPROVE PR #1986 eb7e5cec37ed6bd3b307e180c3d107c6586c8cc3\n\nLooks great, no breaking changes.",
          createdAt: "2026-10-27T17:15:00Z",
        },
      ];
      expect(approvedPrSince(product, comments)).toBe("2026-10-27T17:15:00.000Z");
    });

    it("ignores canonical APPROVE PR header with mismatching SHA", () => {
      const product = {
        status: "open",
        metadata: { number: 1986, headSha: "eb7e5cec37ed6bd3b307e180c3d107c6586c8cc3" },
      };
      const comments = [
        {
          body: "APPROVE PR #1986 1111111122223333444455556666777788889999\n\nApproved previous sha.",
          createdAt: "2026-10-27T17:15:00Z",
        },
      ];
      expect(approvedPrSince(product, comments)).toBeNull();
    });

    it("ignores canonical APPROVE PR header when commit SHA is missing or headSha is missing", () => {
      const product = {
        status: "open",
        metadata: { number: 1986, headSha: "eb7e5cec37ed6bd3b307e180c3d107c6586c8cc3" },
      };
      // Missing SHA in comment
      expect(approvedPrSince(product, [
        { body: "APPROVE PR #1986\n\nLooks good.", createdAt: "2026-10-27T17:15:00Z" },
      ])).toBeNull();

      // Missing headSha in product metadata
      const productNoHeadSha = { status: "open", metadata: { number: 1986 } };
      expect(approvedPrSince(productNoHeadSha, [
        { body: "APPROVE PR #1986 eb7e5cec37ed6bd3b307e180c3d107c6586c8cc3", createdAt: "2026-10-27T17:15:00Z" },
      ])).toBeNull();
    });

    it("detects rejection from canonical header ^REQUEST CHANGES PR #N sha", () => {
      const product = {
        status: "open",
        metadata: { number: 1986, headSha: "eb7e5cec37ed6bd3b307e180c3d107c6586c8cc3" },
      };
      const comments = [
        {
          body: "APPROVE PR #1986 eb7e5cec37ed6bd3b307e180c3d107c6586c8cc3",
          createdAt: "2026-10-27T17:00:00Z",
        },
        {
          body: "REQUEST CHANGES PR #1986 eb7e5cec37ed6bd3b307e180c3d107c6586c8cc3\n\nPlease approve after unit tests pass.",
          createdAt: "2026-10-27T17:30:00Z",
        },
      ];
      expect(approvedPrSince(product, comments)).toBeNull();
    });

    it("handles comments with both approve and changes words when header is decisive", () => {
      const product = { status: "open", metadata: { number: 101, headSha: "abcdef12345678" } };
      const comments = [
        {
          body: "APPROVE PR #101 abcdef12345678\n\nNo requested changes needed.",
          createdAt: "2026-10-27T17:00:00Z",
        },
      ];
      expect(approvedPrSince(product, comments)).toBe("2026-10-27T17:00:00.000Z");
    });

    it("restricts review verdict comments to authorized reviewer", () => {
      const product = { status: "open", metadata: { number: 101, headSha: "abcdef12345678" } };
      const reviewerId = "rev-agent-1";
      const authorId = "author-agent-1";
      const intruderId = "other-agent-2";

      // Self-approval by PR author is ignored
      expect(approvedPrSince(product, [
        { body: "APPROVE PR #101 abcdef12345678", createdAt: "2026-10-27T17:00:00Z", authorAgentId: authorId },
      ], { authorAgentId: authorId, reviewerAgentIds: [reviewerId] })).toBeNull();

      // Comment without authorAgentId is rejected when reviewerAgentIds or authorAgentId is configured
      expect(approvedPrSince(product, [
        { body: "APPROVE PR #101 abcdef12345678", createdAt: "2026-10-27T17:00:00Z" },
      ], { authorAgentId: authorId, reviewerAgentIds: [reviewerId] })).toBeNull();

      // Approval by random agent not in reviewerAgentIds is ignored
      expect(approvedPrSince(product, [
        { body: "APPROVE PR #101 abcdef12345678", createdAt: "2026-10-27T17:00:00Z", authorAgentId: intruderId },
      ], { authorAgentId: authorId, reviewerAgentIds: [reviewerId] })).toBeNull();

      // Approval by designated reviewer is accepted
      expect(approvedPrSince(product, [
        { body: "APPROVE PR #101 abcdef12345678", createdAt: "2026-10-27T17:00:00Z", authorAgentId: reviewerId },
      ], { authorAgentId: authorId, reviewerAgentIds: [reviewerId] })).toBe("2026-10-27T17:00:00.000Z");
    });

    it("respects chronological order between product approval and comment rejection", () => {
      // Rejection at 16:00, then product approved at 17:00 -> approved!
      const product1 = {
        status: "open",
        reviewState: "approved",
        updatedAt: new Date("2026-10-27T17:00:00Z"),
        metadata: { number: 101 },
      };
      const comments1 = [
        { body: "REQUEST CHANGES PR #101", createdAt: "2026-10-27T16:00:00Z" },
      ];
      expect(approvedPrSince(product1, comments1)).toBe("2026-10-27T17:00:00.000Z");

      // Product approved at 16:00, then rejection at 17:00 -> null!
      const product2 = {
        status: "open",
        reviewState: "approved",
        updatedAt: new Date("2026-10-27T16:00:00Z"),
        metadata: { number: 101, reviewApprovedAt: "2026-10-27T16:00:00.000Z" },
      };
      const comments2 = [
        { body: "REQUEST CHANGES PR #101", createdAt: "2026-10-27T17:00:00Z" },
      ];
      expect(approvedPrSince(product2, comments2)).toBeNull();
    });

    it("returns null when product is in changes_requested reviewState even with older approval", () => {
      const product = {
        status: "open",
        reviewState: "changes_requested",
        updatedAt: new Date("2026-10-27T17:00:00Z"),
        metadata: { number: 101, headSha: "abcdef12345678" },
      };
      const comments = [
        { body: "APPROVE PR #101 abcdef12345678", createdAt: "2026-10-27T15:00:00Z" },
      ];
      expect(approvedPrSince(product, comments)).toBeNull();
    });

    it("re-approves if changes requested were followed by a new approve verdict", () => {
      const product = { status: "open", metadata: { number: 101 } };
      const comments = [
        { body: "VERDICT #101: CHANGES REQUESTED", createdAt: "2026-10-27T16:00:00Z" },
        { body: "ВЕРДИКТ #101: ОДОБРЕНО", createdAt: "2026-10-27T17:30:00Z" },
      ];
      expect(approvedPrSince(product, comments)).toBe("2026-10-27T17:30:00.000Z");
    });
  });
});
