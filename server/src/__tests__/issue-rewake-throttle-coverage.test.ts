import { describe, expect, it } from "vitest";
import {
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
});
