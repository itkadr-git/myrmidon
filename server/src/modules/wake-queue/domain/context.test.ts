import { describe, expect, it } from "vitest";
import { enrichPromotedWakeContext } from "./context.js";

describe("enrichPromotedWakeContext", () => {
  it("clears stale derived comment projections when the canonical id list is empty, but keeps an independent interaction continuation", () => {
    const contextSnapshot: Record<string, unknown> = {
      // Normalization already dropped the canonical wake comment ids upstream
      // of this function; no wakeCommentIds field remains on the snapshot.
      paperclipWake: { commentId: "2aa92f18-06b6-4231-a2a5-bf7d7f41718e" },
      paperclipWakeComment: { id: "2aa92f18-06b6-4231-a2a5-bf7d7f41718e", body: "stale body" },
      paperclipTaskMarkdown: "stale markdown",
      paperclipTaskMarkdownCompact: "stale compact markdown",
      // Independent interaction continuation the promoted run must keep.
      interactionId: "interaction-1",
      interactionKind: "request_confirmation",
      interactionStatus: "accepted",
    };

    const result = enrichPromotedWakeContext({
      contextSnapshot,
      reason: "issue_execution_promoted",
      source: "automation",
      triggerDetail: null,
      payload: { mutation: "interaction" },
    });

    expect(result.contextSnapshot.wakeCommentIds).toBeUndefined();
    expect(result.contextSnapshot.commentId).toBeUndefined();
    expect(result.contextSnapshot.wakeCommentId).toBeUndefined();
    expect(result.contextSnapshot.paperclipWake).toBeUndefined();
    expect(result.contextSnapshot.paperclipWakeComment).toBeUndefined();
    expect(result.contextSnapshot.paperclipTaskMarkdown).toBeUndefined();
    expect(result.contextSnapshot.paperclipTaskMarkdownCompact).toBeUndefined();
    // The independent interaction continuation survives the clear.
    expect(result.contextSnapshot.interactionId).toBe("interaction-1");
    expect(result.contextSnapshot.interactionStatus).toBe("accepted");
  });

  it("sets the canonical id and latest-id fields when the recomputed list has entries, and still clears the stale projections", () => {
    const contextSnapshot: Record<string, unknown> = {
      wakeCommentIds: ["0f9d5a1e-2f0d-4a6b-8c6d-1e2f3a4b5c6d"],
      paperclipWake: { commentId: "0f9d5a1e-2f0d-4a6b-8c6d-1e2f3a4b5c6d" },
      paperclipWakeComment: { id: "0f9d5a1e-2f0d-4a6b-8c6d-1e2f3a4b5c6d", body: "will be rebuilt" },
      paperclipTaskMarkdown: "will be rebuilt",
      paperclipTaskMarkdownCompact: "will be rebuilt",
    };

    const result = enrichPromotedWakeContext({
      contextSnapshot,
      reason: "issue_execution_promoted",
      source: "automation",
      triggerDetail: null,
      payload: {},
    });

    expect(result.contextSnapshot.wakeCommentIds).toEqual(["0f9d5a1e-2f0d-4a6b-8c6d-1e2f3a4b5c6d"]);
    expect(result.contextSnapshot.commentId).toBe("0f9d5a1e-2f0d-4a6b-8c6d-1e2f3a4b5c6d");
    expect(result.contextSnapshot.wakeCommentId).toBe("0f9d5a1e-2f0d-4a6b-8c6d-1e2f3a4b5c6d");
    // The derived projections are cleared so the run rebuilds them from the
    // canonical ids instead of carrying forward a queue-time snapshot.
    expect(result.contextSnapshot.paperclipWake).toBeUndefined();
    expect(result.contextSnapshot.paperclipWakeComment).toBeUndefined();
    expect(result.contextSnapshot.paperclipTaskMarkdown).toBeUndefined();
    expect(result.contextSnapshot.paperclipTaskMarkdownCompact).toBeUndefined();
  });

  it("adds a new id from the payload to the canonical list and clears the stale projections", () => {
    const contextSnapshot: Record<string, unknown> = {
      wakeCommentIds: ["0f9d5a1e-2f0d-4a6b-8c6d-1e2f3a4b5c6d"],
      paperclipWakeComment: { id: "0f9d5a1e-2f0d-4a6b-8c6d-1e2f3a4b5c6d", body: "stale body" },
    };

    const result = enrichPromotedWakeContext({
      contextSnapshot,
      reason: "issue_execution_promoted",
      source: "automation",
      triggerDetail: null,
      payload: { commentId: "2aa92f18-06b6-4231-a2a5-bf7d7f41718e" },
    });

    expect(result.contextSnapshot.wakeCommentIds).toEqual(["0f9d5a1e-2f0d-4a6b-8c6d-1e2f3a4b5c6d", "2aa92f18-06b6-4231-a2a5-bf7d7f41718e"]);
    expect(result.contextSnapshot.commentId).toBe("2aa92f18-06b6-4231-a2a5-bf7d7f41718e");
    expect(result.contextSnapshot.wakeCommentId).toBe("2aa92f18-06b6-4231-a2a5-bf7d7f41718e");
    expect(result.contextSnapshot.paperclipWakeComment).toBeUndefined();
  });

  it("drops a malformed payload commentId from the promoted canonical list", () => {
    const contextSnapshot: Record<string, unknown> = {
      wakeCommentIds: ["0f9d5a1e-2f0d-4a6b-8c6d-1e2f3a4b5c6d"],
    };

    const result = enrichPromotedWakeContext({
      contextSnapshot,
      reason: "issue_execution_promoted",
      source: "automation",
      triggerDetail: null,
      // OPE-12209: a malformed id in a promotion payload must never reach the
      // uuid columns; it is dropped instead of persisted into the canonical
      // list the next dispatch resolves against the database.
      payload: { commentId: "abc12345" },
    });

    expect(result.contextSnapshot.wakeCommentIds).toEqual(["0f9d5a1e-2f0d-4a6b-8c6d-1e2f3a4b5c6d"]);
    expect(result.contextSnapshot.commentId).toBe("0f9d5a1e-2f0d-4a6b-8c6d-1e2f3a4b5c6d");
    expect(result.contextSnapshot.wakeCommentId).toBe("0f9d5a1e-2f0d-4a6b-8c6d-1e2f3a4b5c6d");
  });

  it("keeps the raw issue, execution-stage, and accepted-plan fields a dispatch rebuild needs, alongside the cleared text projections", () => {
    const contextSnapshot: Record<string, unknown> = {
      wakeCommentIds: ["0f9d5a1e-2f0d-4a6b-8c6d-1e2f3a4b5c6d"],
      paperclipWake: { commentId: "0f9d5a1e-2f0d-4a6b-8c6d-1e2f3a4b5c6d" },
      paperclipTaskMarkdown: "stale markdown",
      paperclipTaskMarkdownCompact: "stale compact markdown",
      // Raw context a dispatch-time rebuild reads directly off the promoted
      // run; none of it is derived from the comment ids above, so none of it
      // should be cleared alongside the stale text projections.
      issueId: "issue-1",
      executionStage: { stage: "review" },
      planReviewInteraction: { acceptedTargetRevision: { revisionId: "revision-1" } },
      acceptedPlanWakeRouting: { targetAgentId: "agent-1" },
      workspaceRefreshReason: "accepted_plan_confirmation",
    };

    const result = enrichPromotedWakeContext({
      contextSnapshot,
      reason: "issue_execution_promoted",
      source: "automation",
      triggerDetail: null,
      payload: {},
    });

    // The rendered text is cleared; dispatch rebuilds it from the raw fields.
    expect(result.contextSnapshot.paperclipWake).toBeUndefined();
    expect(result.contextSnapshot.paperclipTaskMarkdown).toBeUndefined();
    expect(result.contextSnapshot.paperclipTaskMarkdownCompact).toBeUndefined();
    // The raw fields the rebuild needs are untouched.
    expect(result.contextSnapshot.issueId).toBe("issue-1");
    expect(result.contextSnapshot.executionStage).toEqual({ stage: "review" });
    expect(result.contextSnapshot.planReviewInteraction).toEqual({
      acceptedTargetRevision: { revisionId: "revision-1" },
    });
    expect(result.contextSnapshot.acceptedPlanWakeRouting).toEqual({ targetAgentId: "agent-1" });
    expect(result.contextSnapshot.workspaceRefreshReason).toBe("accepted_plan_confirmation");
  });
});
