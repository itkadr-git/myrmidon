import { describe, expect, it } from "vitest";
import {
  evaluateIssueRewakeThrottle,
  isThrottleCandidateIssueRewake,
  THROTTLED_ISSUE_REWAKE_REASONS,
} from "../services/issue-rewake-throttle.ts";

describe("OPE-10582 automatic rewake coverage", () => {
  it.each(["issue_continuation_needed", "task_ticker", "task-ticker"])(
    "throttles %s without changing event-shaped blocker wake behavior",
    (reason) => {
      expect(THROTTLED_ISSUE_REWAKE_REASONS.has(reason)).toBe(true);
      expect(isThrottleCandidateIssueRewake({
        reason,
        wakeCommentId: null,
        requestedByActorType: "system",
        forceFreshSession: false,
        hasExplicitResume: false,
      })).toBe(true);
      expect(isThrottleCandidateIssueRewake({
        reason: "issue_blockers_resolved",
        wakeCommentId: null,
        requestedByActorType: "system",
        forceFreshSession: false,
        hasExplicitResume: false,
      })).toBe(false);
    },
  );

  it("freezes task_ticker after six consecutive no-progress runs", () => {
    const now = new Date("2026-01-01T00:10:00.000Z");
    const runs = Array.from({ length: 6 }, (_, i) => ({
      id: `ticker-run-${i}`,
      status: "succeeded",
      finishedAt: new Date(now.getTime() - (60 - i * 5) * 1000),
    }));

    const decision = evaluateIssueRewakeThrottle({
      now,
      recentTerminalRuns: runs,
      runIdsWithIssueProgress: new Set(),
      hasNewIssueInputSinceLastRun: false,
    });

    expect(decision).toMatchObject({ blocked: true, frozen: true, noProgressStreak: 6 });
  });

  it("resets the no-progress streak on new issue input", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: new Date(),
      recentTerminalRuns: Array.from({ length: 6 }, (_, i) => ({
        id: `ticker-run-${i}`,
        status: "succeeded",
        finishedAt: new Date(),
      })),
      runIdsWithIssueProgress: new Set(),
      hasNewIssueInputSinceLastRun: true,
    });

    expect(decision).toEqual({ blocked: false, noProgressStreak: 0 });
  });
});
