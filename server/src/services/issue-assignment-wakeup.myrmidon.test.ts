import { describe, expect, it, vi } from "vitest";
import {
  SELF_WAKE_SKIPPED_REASON,
  isSelfWake,
  queueIssueAssignmentWakeup,
} from "./issue-assignment-wakeup.js";

function heartbeatSpy() {
  const wakeup = vi.fn().mockResolvedValue(undefined);
  return { heartbeat: { wakeup }, wakeup };
}

describe("queueIssueAssignmentWakeup", () => {
  it("wakes an Agent Chat conversation with taskKey = issue.id even when a stale taskKey is passed in", async () => {
    const { heartbeat, wakeup } = heartbeatSpy();
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: {
        id: "issue-a",
        assigneeAgentId: "agent-a",
        status: "in_review",
        conversationAgentId: "agent-a",
        conversationUserId: "user-a",
      },
      reason: "External chat message received",
      mutation: "chat_message_received",
      contextSource: "chat:telegram",
      taskKey: "ABC-1",
    });
    expect(wakeup).toHaveBeenCalledTimes(1);
    const opts = wakeup.mock.calls[0][1];
    expect(opts.payload.taskKey).toBe("issue-a");
    expect(opts.contextSnapshot.taskKey).toBe("issue-a");
  });

  it("wakes an Agent Chat conversation with taskKey = issue.id when no taskKey is passed in", async () => {
    const { heartbeat, wakeup } = heartbeatSpy();
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: {
        id: "issue-a",
        assigneeAgentId: "agent-a",
        status: "in_review",
        conversationAgentId: "agent-a",
        conversationUserId: "user-a",
      },
      reason: "External chat message received",
      mutation: "chat_message_received",
      contextSource: "chat:telegram",
    });
    const opts = heartbeat.wakeup.mock.calls[0][1];
    expect(opts.payload.taskKey).toBe("issue-a");
    expect(opts.contextSnapshot.taskKey).toBe("issue-a");
  });

  it("keeps the caller's taskKey for a plain (non-conversation) task", async () => {
    const { heartbeat } = heartbeatSpy();
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-b", assigneeAgentId: "agent-a", status: "in_review" },
      reason: "External chat message received",
      mutation: "chat_message_received",
      contextSource: "chat:telegram",
      taskKey: "ABC-1",
    });
    const opts = heartbeat.wakeup.mock.calls[0][1];
    expect(opts.payload.taskKey).toBe("ABC-1");
    expect(opts.contextSnapshot.taskKey).toBe("ABC-1");
  });

  it("treats a Telegram-keyed conversation (conversationUserId = telegram:user-a) as a conversation too", async () => {
    const { heartbeat } = heartbeatSpy();
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: {
        id: "issue-c",
        assigneeAgentId: "agent-a",
        status: "in_review",
        conversationAgentId: "agent-a",
        conversationUserId: "telegram:user-a",
      },
      reason: "External chat message received",
      mutation: "chat_message_received",
      contextSource: "chat:telegram",
      taskKey: "ABC-2",
    });
    const opts = heartbeat.wakeup.mock.calls[0][1];
    expect(opts.payload.taskKey).toBe("issue-c");
    expect(opts.contextSnapshot.taskKey).toBe("issue-c");
  });

  // Regression for vendor paperclipai/paperclip #13738 (commit 0f5fafe16):
  // assigning (or re-assigning) an issue in a closed status must never wake
  // the assignee. The guard lives in the shared service so every call point —
  // create, child_create, accepted_plan_decomposition, interaction_accept,
  // status cards — is covered in one place.
  it.each(["done", "cancelled"] as const)(
    "does not wake the assignee when an issue in status '%s' is assigned",
    async (status) => {
      const { heartbeat, wakeup } = heartbeatSpy();
      await queueIssueAssignmentWakeup({
        heartbeat,
        issue: { id: "issue-closed", assigneeAgentId: "agent-a", status },
        reason: "issue_assigned",
        mutation: "create",
        contextSource: "issue.create",
      });
      expect(wakeup).not.toHaveBeenCalled();
    },
  );

  it("keeps suppressing wakes for backlog issues (pre-existing guard)", async () => {
    const { heartbeat, wakeup } = heartbeatSpy();
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-backlog", assigneeAgentId: "agent-a", status: "backlog" },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
    });
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("still wakes for open statuses (todo / in_progress / in_review / blocked)", async () => {
    for (const status of ["todo", "in_progress", "in_review", "blocked"]) {
      const { heartbeat, wakeup } = heartbeatSpy();
      await queueIssueAssignmentWakeup({
        heartbeat,
        issue: { id: `issue-${status}`, assigneeAgentId: "agent-a", status },
        reason: "issue_assigned",
        mutation: "create",
        contextSource: "issue.create",
      });
      expect(wakeup).toHaveBeenCalledTimes(1);
    }
  });

  it("wakes when a closed issue is explicitly reopened (transition carries the new status)", async () => {
    // The reopen path queues the wake with the issue's NEW status (the status
    // is patched before the wake is enqueued), so the closed-status guard must
    // not swallow reopens.
    const { heartbeat, wakeup } = heartbeatSpy();
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-reopened", assigneeAgentId: "agent-a", status: "todo" },
      reason: "issue_assigned",
      mutation: "update",
      contextSource: "issue.update",
    });
    expect(wakeup).toHaveBeenCalledTimes(1);
  });
});

// myrmidon(1.6.6 OPE-12049, TOKEN-BURN H): the assignee's own write never wakes
// the assignee; every other actor still does.
describe("queueIssueAssignmentWakeup: an agent does not wake itself", () => {
  const issue = { id: "issue-s", assigneeAgentId: "agent-a", status: "todo" };
  const base = {
    issue,
    reason: "issue_assigned",
    mutation: "update",
    contextSource: "issue.update",
  };

  it("skips the wake when the acting agent is the assignee", async () => {
    const { heartbeat, wakeup } = heartbeatSpy();
    const result = await queueIssueAssignmentWakeup({
      ...base,
      heartbeat,
      requestedByActorType: "agent",
      requestedByActorId: "agent-a",
    });
    expect(wakeup).not.toHaveBeenCalled();
    expect(result).toBeNull();
    expect(SELF_WAKE_SKIPPED_REASON).toBe("self_wake_skipped");
  });

  it("skips the swarm_matched reason too when the assignee is the acting agent", async () => {
    const { heartbeat, wakeup } = heartbeatSpy();
    await queueIssueAssignmentWakeup({
      ...base,
      heartbeat,
      reason: "swarm_matched",
      mutation: "swarm_matched",
      contextSource: "swarm_matched",
      requestedByActorType: "agent",
      requestedByActorId: "agent-a",
    });
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("wakes the assignee when another agent made the change", async () => {
    const { heartbeat, wakeup } = heartbeatSpy();
    await queueIssueAssignmentWakeup({
      ...base,
      heartbeat,
      requestedByActorType: "agent",
      requestedByActorId: "agent-b",
    });
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls[0][0]).toBe("agent-a");
    expect(wakeup.mock.calls[0][1]).toMatchObject({
      requestedByActorType: "agent",
      requestedByActorId: "agent-b",
    });
  });

  it("wakes the assignee when a user made the change, even with the same id string", async () => {
    const { heartbeat, wakeup } = heartbeatSpy();
    await queueIssueAssignmentWakeup({
      ...base,
      heartbeat,
      requestedByActorType: "user",
      requestedByActorId: "agent-a",
    });
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("wakes the assignee for a system actor and for a caller that reports no actor", async () => {
    const { heartbeat, wakeup } = heartbeatSpy();
    await queueIssueAssignmentWakeup({ ...base, heartbeat, requestedByActorType: "system" });
    await queueIssueAssignmentWakeup({ ...base, heartbeat });
    await queueIssueAssignmentWakeup({
      ...base,
      heartbeat,
      requestedByActorType: "agent",
      requestedByActorId: null,
    });
    expect(wakeup).toHaveBeenCalledTimes(3);
  });

  it("isSelfWake needs an agent actor whose id is the assignee", () => {
    expect(isSelfWake({ assigneeAgentId: "a", requestedByActorType: "agent", requestedByActorId: "a" })).toBe(true);
    expect(isSelfWake({ assigneeAgentId: "a", requestedByActorType: "agent", requestedByActorId: "b" })).toBe(false);
    expect(isSelfWake({ assigneeAgentId: "a", requestedByActorType: "user", requestedByActorId: "a" })).toBe(false);
    expect(isSelfWake({ assigneeAgentId: null, requestedByActorType: "agent", requestedByActorId: null })).toBe(false);
    expect(isSelfWake({ assigneeAgentId: "a" })).toBe(false);
  });
});
