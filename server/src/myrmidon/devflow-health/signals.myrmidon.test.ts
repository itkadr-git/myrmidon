import { describe, expect, it } from "vitest";
import { approvedPrSince, buildDevflowSignals, redCiSince } from "./signals.js";

const now = new Date("2026-10-27T20:00:00Z");
describe("DEVFLOW runtime signals", () => {
  it("delivers a company-scoped deterministic alert only at the threshold", () => {
    const sample = { companyId: "company-a", subjectId: "issue-a", subjectKind: "issue" as const,
      title: "Review", metric: "reviewQueueAgeMs" as const, since: "2026-10-27T19:59:00Z" };
    expect(buildDevflowSignals([sample], { reviewQueueAgeMs: 60_001 }, now)).toEqual([]);
    expect(buildDevflowSignals([sample], { reviewQueueAgeMs: 60_000 }, now)).toMatchObject([
      { companyId: "company-a", subjectId: "issue-a", durationMs: 60_000, dedupKey: "devflow:company-a:reviewQueueAgeMs:issue-a" },
    ]);
  });
  it("delivers approvedNotMergedMs alerts when duration meets threshold", () => {
    const sample = { companyId: "company-a", subjectId: "issue-b", subjectKind: "issue" as const,
      title: "Task with approved PR", metric: "approvedNotMergedMs" as const, since: "2026-10-27T18:00:00Z" };
    expect(buildDevflowSignals([sample], { approvedNotMergedMs: 7_200_001 }, now)).toEqual([]);
    expect(buildDevflowSignals([sample], { approvedNotMergedMs: 7_200_000 }, now)).toMatchObject([
      { companyId: "company-a", subjectId: "issue-b", durationMs: 7_200_000, dedupKey: "devflow:company-a:approvedNotMergedMs:issue-b" },
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
    expect(redCiSince([{ conclusion: "cancelled", at: now.toISOString() },
      { conclusion: "failure", at: "invalid" }])).toBeNull();
  });

  describe("approvedPrSince", () => {
    it("returns null for merged or closed PRs", () => {
      expect(approvedPrSince({ status: "merged", reviewState: "approved" })).toBeNull();
      expect(approvedPrSince({ status: "closed", reviewState: "approved" })).toBeNull();
    });

    it("detects approval from product reviewState", () => {
      const updatedAt = new Date("2026-10-27T18:00:00Z");
      expect(approvedPrSince({ status: "open", reviewState: "approved", updatedAt })).toBe("2026-10-27T18:00:00.000Z");
    });

    it("detects approval from metadata reviewApproved / labels", () => {
      const updatedAt = new Date("2026-10-27T17:30:00Z");
      expect(approvedPrSince({ status: "open", metadata: { reviewApproved: true }, updatedAt })).toBe("2026-10-27T17:30:00.000Z");
      expect(approvedPrSince({ status: "open", metadata: { labels: ["review-approved"] }, updatedAt })).toBe("2026-10-27T17:30:00.000Z");
      expect(approvedPrSince({ status: "open", metadata: { reviewApprovedAt: "2026-10-27T16:00:00.000Z" } })).toBe("2026-10-27T16:00:00.000Z");
    });

    it("detects approval from issue verdict comments", () => {
      const product = { status: "open", metadata: { number: 101 } };
      const comments = [
        { body: "Running tests...", createdAt: "2026-10-27T17:00:00Z" },
        { body: "VERDICT #101: APPROVE (head abcdef)", createdAt: "2026-10-27T17:15:00Z" },
      ];
      expect(approvedPrSince(product, comments)).toBe("2026-10-27T17:15:00.000Z");
    });

    it("clears approval if later comment requests changes or rework", () => {
      const product = { status: "open", metadata: { number: 101 } };
      const comments = [
        { body: "VERDICT #101: APPROVE", createdAt: "2026-10-27T17:15:00Z" },
        { body: "VERDICT #101: CHANGES REQUESTED - fix tests", createdAt: "2026-10-27T17:45:00Z" },
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
