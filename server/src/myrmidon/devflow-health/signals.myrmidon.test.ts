import { describe, expect, it } from "vitest";
import {
  buildDevflowSignals,
  redCiSince,
  staleMarkerSince,
  stalledMergeSince,
  stalledRouterSince,
} from "./signals.js";

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
      {
        companyId: "company-a",
        subjectId: "issue-a",
        durationMs: 60_000,
        dedupKey: "devflow:company-a:reviewQueueAgeMs:issue-a",
      },
    ]);
  });

  it("builds alerts for stale marker, stalled merge, and stalled router with dedup keys", () => {
    const samples = [
      {
        companyId: "company-a",
        subjectId: "issue-1",
        subjectKind: "issue" as const,
        title: "PR 1",
        metric: "staleMarkerMs" as const,
        since: "2026-10-27T19:00:00Z", // 60 min ago
      },
      {
        companyId: "company-a",
        subjectId: "issue-2",
        subjectKind: "issue" as const,
        title: "PR 2",
        metric: "stalledMergeMs" as const,
        since: "2026-10-27T18:30:00Z", // 90 min ago
      },
      {
        companyId: "company-a",
        subjectId: "issue-3",
        subjectKind: "issue" as const,
        title: "Issue 3",
        metric: "stalledRouterMs" as const,
        since: "2026-10-27T19:20:00Z", // 40 min ago
      },
    ];

    const signals = buildDevflowSignals(
      samples,
      {
        staleMarkerMs: 50 * 60_000,
        stalledMergeMs: 60 * 60_000,
        stalledRouterMs: 50 * 60_000, // 40 min is below this threshold
      },
      now,
    );

    expect(signals).toHaveLength(2);
    expect(signals[0]).toMatchObject({
      metric: "staleMarkerMs",
      subjectId: "issue-1",
      durationMs: 3_600_000,
      dedupKey: "devflow:company-a:staleMarkerMs:issue-1",
    });
    expect(signals[1]).toMatchObject({
      metric: "stalledMergeMs",
      subjectId: "issue-2",
      durationMs: 5_400_000,
      dedupKey: "devflow:company-a:stalledMergeMs:issue-2",
    });
  });

  describe("staleMarkerSince (Approval-to-PR-marker step)", () => {
    const approveVerdict = {
      outcome: "approve" as const,
      at: "2026-10-27T19:00:00Z",
      headSha: "abc1234",
    };

    it("emits verdict timestamp when APPROVE verdict exists and marker is missing", () => {
      expect(
        staleMarkerSince({
          verdict: approveVerdict,
          marker: { hasMarker: false },
          prStatus: "open",
          currentHeadSha: "abc1234",
        }),
      ).toBe("2026-10-27T19:00:00Z");
    });

    it("emits verdict timestamp when marker was applied prior to the verdict (stale marker)", () => {
      expect(
        staleMarkerSince({
          verdict: approveVerdict,
          marker: { hasMarker: true, markedAt: "2026-10-27T18:30:00Z" },
          prStatus: "open",
          currentHeadSha: "abc1234",
        }),
      ).toBe("2026-10-27T19:00:00Z");
    });

    it("emits verdict timestamp when head moved after review (head mismatch)", () => {
      expect(
        staleMarkerSince({
          verdict: approveVerdict, // for head abc1234
          marker: { hasMarker: true, markedAt: "2026-10-27T19:05:00Z" },
          prStatus: "open",
          currentHeadSha: "def5678", // new head
        }),
      ).toBe("2026-10-27T19:00:00Z");
    });

    it("recovers (returns null) when marker is applied at or after verdict on current head", () => {
      expect(
        staleMarkerSince({
          verdict: approveVerdict,
          marker: { hasMarker: true, markedAt: "2026-10-27T19:01:00Z" },
          prStatus: "open",
          currentHeadSha: "abc1234",
        }),
      ).toBeNull();
    });

    it("recovers (returns null) when PR is merged or closed", () => {
      expect(
        staleMarkerSince({
          verdict: approveVerdict,
          marker: { hasMarker: false },
          prStatus: "merged",
        }),
      ).toBeNull();
      expect(
        staleMarkerSince({
          verdict: approveVerdict,
          marker: { hasMarker: false },
          prStatus: "closed",
        }),
      ).toBeNull();
    });

    it("does not alert when verdict is return/rework or missing", () => {
      expect(
        staleMarkerSince({
          verdict: { outcome: "return", at: "2026-10-27T19:00:00Z" },
          marker: { hasMarker: false },
          prStatus: "open",
        }),
      ).toBeNull();
      expect(
        staleMarkerSince({
          verdict: null,
          marker: { hasMarker: false },
          prStatus: "open",
        }),
      ).toBeNull();
    });
  });

  describe("stalledMergeSince (Auto-merge step)", () => {
    it("emits approval timestamp when approved and PR remains open", () => {
      expect(
        stalledMergeSince({
          approvedAt: "2026-10-27T19:00:00Z",
          prStatus: "open",
          isMerged: false,
        }),
      ).toBe("2026-10-27T19:00:00Z");
    });

    it("recovers (returns null) when PR is merged", () => {
      expect(
        stalledMergeSince({
          approvedAt: "2026-10-27T19:00:00Z",
          prStatus: "open",
          isMerged: true,
        }),
      ).toBeNull();
      expect(
        stalledMergeSince({
          approvedAt: "2026-10-27T19:00:00Z",
          prStatus: "merged",
          isMerged: false,
        }),
      ).toBeNull();
    });

    it("recovers (returns null) when PR is closed or not approved", () => {
      expect(
        stalledMergeSince({
          approvedAt: "2026-10-27T19:00:00Z",
          prStatus: "closed",
        }),
      ).toBeNull();
      expect(
        stalledMergeSince({
          approvedAt: null,
          prStatus: "open",
        }),
      ).toBeNull();
    });
  });

  describe("stalledRouterSince (Review router queue)", () => {
    it("emits inReview timestamp when issue is in_review without a reviewer", () => {
      expect(
        stalledRouterSince({
          status: "in_review",
          needsReviewer: true,
          inReviewSince: "2026-10-27T18:00:00Z",
        }),
      ).toBe("2026-10-27T18:00:00Z");
    });

    it("recovers (returns null) when a reviewer is assigned", () => {
      expect(
        stalledRouterSince({
          status: "in_review",
          needsReviewer: false,
          inReviewSince: "2026-10-27T18:00:00Z",
        }),
      ).toBeNull();
    });

    it("recovers (returns null) when issue moves out of in_review", () => {
      expect(
        stalledRouterSince({
          status: "in_progress",
          needsReviewer: true,
          inReviewSince: "2026-10-27T18:00:00Z",
        }),
      ).toBeNull();
    });
  });

  describe("redCiSince", () => {
    it("preserves the first failure until a successful completion, ignoring reruns in progress", () => {
      expect(
        redCiSince([
          { conclusion: "failure", at: "2026-10-27T18:00:00Z" },
          { conclusion: "failure", at: "2026-10-27T19:00:00Z" },
          { conclusion: null, at: "2026-10-27T19:30:00Z" },
        ]),
      ).toBe("2026-10-27T18:00:00Z");
      expect(
        redCiSince([
          { conclusion: "success", at: "2026-10-27T19:00:00Z" },
          { conclusion: "failure", at: "2026-10-27T18:00:00Z" },
        ]),
      ).toBeNull();
    });

    it("does not turn cancelled/skipped/invalid events into red CI", () => {
      expect(
        redCiSince([
          { conclusion: "cancelled", at: now.toISOString() },
          { conclusion: "failure", at: "invalid" },
        ]),
      ).toBeNull();
    });
  });
});
