import { describe, expect, it } from "vitest";
import { mergeCoalescedContextSnapshot } from "../services/heartbeat.ts";

// myrmidon(CHAT-SOURCE): a coalesced background event wake must not replace a
// live run's chat origin; the event is recorded as the last wake instead.
describe("coalesced non-chat event wake context provenance", () => {
  // The live shape of a chat-origin run before an automation wake coalesces
  // into it: a Telegram-bound run whose snapshot carries the chat provenance.
  const liveChatRunContext = {
    issueId: "issue-1",
    taskId: "issue-1",
    taskKey: "issue-1",
    source: "chat:telegram",
    commentId: "comment-1",
    wakeCommentId: "comment-1",
    wakeCommentIds: ["comment-1"],
    wakeReason: "External chat message received",
    wakeSource: "assignment",
    paperclipHarnessCheckedOut: true,
  };
  const childrenCompletedWake = {
    issueId: "issue-1",
    taskId: "issue-1",
    source: "issue.children_completed",
    wakeReason: "issue_children_completed",
    wakeSource: "automation",
    childIssueIds: ["child-1", "child-2"],
    completedChildIssueId: "child-1",
  };

  it("keeps the live chat origin and records the event wake separately", () => {
    const merged = mergeCoalescedContextSnapshot(
      liveChatRunContext,
      childrenCompletedWake,
    );

    expect(merged).toMatchObject({
      source: "chat:telegram",
      lastWakeSource: "issue.children_completed",
      // `source` and `wakeReason` describe the same event; the preserved pair
      // must not be mixed with the incoming reason.
      wakeReason: "External chat message received",
      lastWakeReason: "issue_children_completed",
      wakeCommentId: "comment-1",
      wakeCommentIds: ["comment-1"],
      paperclipHarnessCheckedOut: true,
      completedChildIssueId: "child-1",
      childIssueIds: ["child-1", "child-2"],
    });
  });

  it("retains the run's own admitted execution binding when the event wake adds no scope", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        ...liveChatRunContext,
        paperclipExternalChatExecutionBound: true,
        paperclipWake: {
          issue: { id: "issue-1", status: "in_progress" },
          commentIds: ["comment-1"],
          externalChatProvider: "telegram",
          externalChatExecutionBound: true,
          checkedOutByHarness: false,
        },
      },
      childrenCompletedWake,
    );

    expect(merged.source).toBe("chat:telegram");
    expect(merged.paperclipExternalChatExecutionBound).toBe(true);
  });

  it("drops the execution binding when the coalesced wake widens the admitted scope", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        ...liveChatRunContext,
        paperclipExternalChatExecutionBound: true,
        paperclipWake: {
          issue: { id: "issue-1", status: "in_progress" },
          commentIds: ["comment-1"],
          externalChatProvider: "telegram",
          externalChatExecutionBound: true,
          checkedOutByHarness: false,
        },
      },
      {
        ...childrenCompletedWake,
        commentId: "comment-2",
        wakeCommentId: "comment-2",
        wakeCommentIds: ["comment-2"],
      },
    );

    expect(merged.source).toBe("chat:telegram");
    expect(merged.paperclipExternalChatExecutionBound).toBeUndefined();
  });

  it("lets an interactive continuation replace the live chat origin", () => {
    const merged = mergeCoalescedContextSnapshot(liveChatRunContext, {
      issueId: "issue-1",
      taskId: "issue-1",
      source: "issue.interaction.respond",
      wakeReason: "issue_commented",
      interactionId: "interaction-1",
      interactionKind: "ask_user_questions",
      interactionStatus: "answered",
    });

    expect(merged.source).toBe("issue.interaction.respond");
    expect(merged.lastWakeSource).toBeUndefined();
    expect(merged.wakeReason).toBe("issue_commented");
  });

  it("lets an incoming chat source stay authoritative", () => {
    const merged = mergeCoalescedContextSnapshot(liveChatRunContext, {
      issueId: "issue-1",
      source: "chat:slack",
      wakeReason: "External chat message received",
      commentId: "cm-2",
      wakeCommentId: "cm-2",
      wakeCommentIds: ["cm-2"],
    });

    expect(merged.source).toBe("chat:slack");
    expect(merged.lastWakeSource).toBeUndefined();
  });

  it("does not carry chat provenance across a different issue", () => {
    const merged = mergeCoalescedContextSnapshot(liveChatRunContext, {
      ...childrenCompletedWake,
      issueId: "issue-2",
      taskId: "issue-2",
    });

    expect(merged.source).toBe("issue.children_completed");
    expect(merged.lastWakeSource).toBeUndefined();
  });
});
