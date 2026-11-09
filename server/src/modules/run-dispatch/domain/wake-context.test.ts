import { describe, expect, it } from "vitest";
import {
  allowsIssueInteractionWake,
  deriveCommentId,
  extractWakeCommentIds,
  isNonAssigneeWorkspaceBusyRetry,
  isResolvedInteractionContinuationWakeContext,
  isValidWakeCommentId,
  WORKSPACE_BUSY_RETRY_REASON,
} from "./wake-context.js";

describe("wake context", () => {
  it("requires the subscription-specific non-assignee receipt for a subscription wait", () => {
    expect(isNonAssigneeWorkspaceBusyRetry("ai_connection_busy", {
      aiConnectionBusyDeferredWhileAssignee: false,
    })).toBe(true);
    for (const context of [ {}, { aiConnectionBusyDeferredWhileAssignee: true }, { workspaceBusyDeferredWhileAssignee: false } ]) {
      expect(isNonAssigneeWorkspaceBusyRetry("ai_connection_busy", context)).toBe(false);
    }
    expect(isNonAssigneeWorkspaceBusyRetry("transient_failure", { aiConnectionBusyDeferredWhileAssignee: false })).toBe(false);
  });
  it("recognizes only workspace-busy retries deferred outside assignee-ship", () => {
    expect(isNonAssigneeWorkspaceBusyRetry(WORKSPACE_BUSY_RETRY_REASON, {
      workspaceBusyDeferredWhileAssignee: false,
    })).toBe(true);
    expect(isNonAssigneeWorkspaceBusyRetry(WORKSPACE_BUSY_RETRY_REASON, {
      workspaceBusyDeferredWhileAssignee: true,
    })).toBe(false);
    expect(isNonAssigneeWorkspaceBusyRetry("another_reason", {
      workspaceBusyDeferredWhileAssignee: false,
    })).toBe(false);
  });

  it("keeps ordered, unique wake comment ids that parse as comment UUIDs", () => {
    expect(extractWakeCommentIds({
      wakeCommentIds: [
        "0f9d5a1e-2f0d-4a6b-8c6d-1e2f3a4b5c6d",
        "",
        "   ",
        null,
        undefined,
        123,
        "abc12345",
        "2aa92f18-06b6-4231-a2a5-bf7d7f41718e",
        "0f9d5a1e-2f0d-4a6b-8c6d-1e2f3a4b5c6d",
      ],
    })).toEqual([
      "0f9d5a1e-2f0d-4a6b-8c6d-1e2f3a4b5c6d",
      "2aa92f18-06b6-4231-a2a5-bf7d7f41718e",
    ]);
    expect(extractWakeCommentIds({
      wakeCommentIds: "0f9d5a1e-2f0d-4a6b-8c6d-1e2f3a4b5c6d",
    })).toEqual([]);
    expect(extractWakeCommentIds(undefined)).toEqual([]);
  });

  it("validates comment ids strictly at the uuid boundary (vendor #13912 isUuidLike)", () => {
    expect(isValidWakeCommentId("0f9d5a1e-2f0d-4a6b-8c6d-1e2f3a4b5c6d")).toBe(true);
    expect(isValidWakeCommentId(" 0f9d5a1e-2f0d-4a6b-8c6d-1e2f3a4b5c6d ")).toBe(true);
    for (const bad of ["abc12345", "", "   ", null, undefined, 123, "not-a-uuid-at-all-whatsoever"]) {
      expect(isValidWakeCommentId(bad)).toBe(false);
    }
  });

  it.each([
    [{ wakeCommentIds: ["9f306e82-1c41-4d75-8c32-6e7f8193a3b3", "a0417f93-2d52-4e86-9d43-7f8092a4b4c4"], wakeCommentId: "b15280a4-3e63-4f97-8e54-8091a3b5c5d5" }, {}, "a0417f93-2d52-4e86-9d43-7f8092a4b4c4"],
    [{ wakeCommentId: "b15280a4-3e63-4f97-8e54-8091a3b5c5d5", commentId: "c26391b5-4f74-4a08-9f65-9102b4c6d6e6" }, {}, "b15280a4-3e63-4f97-8e54-8091a3b5c5d5"],
    [{ commentId: "c26391b5-4f74-4a08-9f65-9102b4c6d6e6" }, { commentId: "d37402c6-5085-4b19-8076-a213b5d7e7f7" }, "c26391b5-4f74-4a08-9f65-9102b4c6d6e6"],
    [{}, { commentId: "d37402c6-5085-4b19-8076-a213b5d7e7f7" }, "d37402c6-5085-4b19-8076-a213b5d7e7f7"],
    [{ wakeCommentId: "  " }, { commentId: "  " }, null],
  ])("derives comment ids by canonical precedence", (context, payload, expected) => {
    expect(deriveCommentId(context, payload)).toBe(expected);
  });

  it("allows interaction wakes only for an allowed reason with a comment id", () => {
    const allowed = new Set(["issue_commented"]);
    expect(allowsIssueInteractionWake({
      wakeReason: "issue_commented",
      wakeCommentId: "0f9d5a1e-2f0d-4a6b-8c6d-1e2f3a4b5c6d",
    }, allowed)).toBe(true);
    expect(allowsIssueInteractionWake({
      wakeReason: "timer",
      wakeCommentId: "0f9d5a1e-2f0d-4a6b-8c6d-1e2f3a4b5c6d",
    }, allowed)).toBe(false);
    expect(allowsIssueInteractionWake({ wakeReason: "issue_commented" }, allowed)).toBe(false);
    expect(allowsIssueInteractionWake({
      wakeReason: "issue_commented",
      wakeCommentId: "   ",
    }, allowed)).toBe(false);
  });

  it.each(["accepted", "answered", "cancelled", "rejected"])(
    "recognizes %s issue-comment interaction continuations",
    (interactionStatus) => {
      expect(isResolvedInteractionContinuationWakeContext({
        interactionId: "interaction-1",
        interactionStatus,
        mutation: "interaction",
        wakeReason: "issue_commented",
      })).toBe(true);
    },
  );

  it.each(["accepted", "answered", "cancelled", "rejected"])(
    "recognizes %s infrastructure continuations and rejects incomplete contexts",
    (interactionStatus) => {
      const base = { interactionId: "interaction-1", interactionStatus };
      expect(isResolvedInteractionContinuationWakeContext({
        ...base,
        wakeReason: "interaction_continuation_infra_retry",
      })).toBe(true);
      expect(isResolvedInteractionContinuationWakeContext({
        ...base,
        retryReason: "interaction_continuation_infra_retry",
      })).toBe(true);
      expect(isResolvedInteractionContinuationWakeContext({
        ...base,
        interactionStatus: "pending",
      })).toBe(false);
      expect(isResolvedInteractionContinuationWakeContext({ interactionStatus })).toBe(false);
      expect(isResolvedInteractionContinuationWakeContext(null)).toBe(false);
    },
  );
});
