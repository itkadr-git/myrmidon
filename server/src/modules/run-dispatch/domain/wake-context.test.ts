import { describe, expect, it } from "vitest";
import {
  allowsIssueInteractionWake,
  deriveCommentId,
  extractWakeCommentIds,
  isNonAssigneeWorkspaceBusyRetry,
  isResolvedInteractionContinuationWakeContext,
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

  it("keeps ordered, unique, non-empty wake comment ids", () => {
    const id1 = "11111111-1111-4111-8111-111111111111";
    const id2 = "22222222-2222-4222-8222-222222222222";
    expect(
      extractWakeCommentIds({
        wakeCommentIds: [id1, "", "   ", null, undefined, 123, "not-a-uuid", id2],
      }),
    ).toEqual([id1, id2]);
    expect(
      extractWakeCommentIds({
        wakeCommentIds: ["   ", "\t\n  ", "not-a-uuid"],
      }),
    ).toEqual([]);
    expect(extractWakeCommentIds({ wakeCommentIds: id1 })).toEqual([]);
    expect(extractWakeCommentIds(undefined)).toEqual([]);
  });

  it.each([
    [
      {
        wakeCommentIds: [
          "11111111-1111-4111-8111-111111111111",
          "22222222-2222-4222-8222-222222222222",
        ],
        wakeCommentId: "33333333-3333-4333-8333-333333333333",
      },
      {},
      "22222222-2222-4222-8222-222222222222",
    ],
    [
      {
        wakeCommentId: "33333333-3333-4333-8333-333333333333",
        commentId: "44444444-4444-4444-8444-444444444444",
      },
      {},
      "33333333-3333-4333-8333-333333333333",
    ],
    [
      { commentId: "44444444-4444-4444-8444-444444444444" },
      { commentId: "55555555-5555-4555-8555-555555555555" },
      "44444444-4444-4444-8444-444444444444",
    ],
    [{}, { commentId: "55555555-5555-4555-8555-555555555555" }, "55555555-5555-4555-8555-555555555555"],
    [{ wakeCommentId: "  " }, { commentId: "  " }, null],
    [{ wakeCommentId: "not-a-uuid" }, { commentId: "bad-id" }, null],
  ])("derives comment ids by canonical precedence", (context, payload, expected) => {
    expect(deriveCommentId(context, payload)).toBe(expected);
  });

  it("allows interaction wakes only for an allowed reason with a comment id", () => {
    const allowed = new Set(["issue_commented"]);
    const id = "11111111-1111-4111-8111-111111111111";
    expect(allowsIssueInteractionWake({
      wakeReason: "issue_commented",
      wakeCommentId: id,
    }, allowed)).toBe(true);
    expect(allowsIssueInteractionWake({
      wakeReason: "timer",
      wakeCommentId: id,
    }, allowed)).toBe(false);
    expect(allowsIssueInteractionWake({ wakeReason: "issue_commented" }, allowed)).toBe(false);
    expect(allowsIssueInteractionWake({
      wakeReason: "issue_commented",
      wakeCommentId: "not-a-uuid",
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
      expect(isResolvedInteractionContinuationWakeContext({ ...base, interactionStatus: "pending" })).toBe(false);
      expect(isResolvedInteractionContinuationWakeContext({ interactionStatus })).toBe(false);
      expect(isResolvedInteractionContinuationWakeContext(null)).toBe(false);
    },
  );
});
