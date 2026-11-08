import { describe, expect, it } from "vitest";
import {
  CONTINUATION_ACTIONABLE_STATUSES,
  CONTINUATION_CAP_COMMENT,
  MAX_CONTINUATIONS_WITHOUT_EXTERNAL_INPUT,
  buildContinuationCapBlockedPatch,
  continuationStatusesFor,
  countContinuationsWithoutExternalInput,
  isContinuationActionable,
} from "./continuation-cap.js";
import type { TaskMovement } from "./wake-task-guard.js";

const AGENT = "agent-a";
const OTHER_AGENT = "agent-b";
const T0 = Date.parse("2026-11-06T00:00:00.000Z");
const minutes = (n: number) => new Date(T0 + n * 60_000);

// Newest first, like the query that feeds the counter.
const runsAt = (...offsets: number[]) => offsets.map((n) => ({ createdAt: minutes(n) }));

describe("isContinuationActionable (OPE-11948 status gate)", () => {
  it("accepts only todo / in_progress assigned to the woken agent", () => {
    expect(CONTINUATION_ACTIONABLE_STATUSES).toEqual(["todo", "in_progress"]);
    expect(isContinuationActionable({ status: "todo", assigneeAgentId: AGENT }, AGENT)).toBe(true);
    expect(isContinuationActionable({ status: "in_progress", assigneeAgentId: AGENT }, AGENT)).toBe(true);
  });

  it.each(["backlog", "blocked", "in_review", "done", "cancelled"])("rejects %s", (status) => {
    expect(isContinuationActionable({ status, assigneeAgentId: AGENT }, AGENT)).toBe(false);
  });

  it("rejects an issue assigned to another agent or to nobody", () => {
    expect(isContinuationActionable({ status: "in_progress", assigneeAgentId: OTHER_AGENT }, AGENT)).toBe(false);
    expect(isContinuationActionable({ status: "in_progress", assigneeAgentId: null }, AGENT)).toBe(false);
  });

  it("lets a continuation that answers a resolved interaction card run in_review too, but nothing else", () => {
    const interaction = { interaction: true };
    expect(isContinuationActionable({ status: "in_review", assigneeAgentId: AGENT }, AGENT, interaction)).toBe(true);
    expect(isContinuationActionable({ status: "in_review", assigneeAgentId: AGENT }, AGENT)).toBe(false);
    for (const status of ["backlog", "blocked", "done", "cancelled"]) {
      expect(isContinuationActionable({ status, assigneeAgentId: AGENT }, AGENT, interaction)).toBe(false);
    }
    expect(isContinuationActionable({ status: "in_review", assigneeAgentId: OTHER_AGENT }, AGENT, interaction)).toBe(false);
    expect(continuationStatusesFor(true)).toEqual(["todo", "in_progress", "in_review"]);
    expect(continuationStatusesFor(false)).toEqual(["todo", "in_progress"]);
  });
});

describe("countContinuationsWithoutExternalInput (OPE-11948 real attempt counter)", () => {
  it("counts every run when nothing external happened", () => {
    expect(countContinuationsWithoutExternalInput({ agentId: AGENT, runs: runsAt(30, 20, 10), moves: [] })).toBe(3);
  });

  it("does not let the agent's own comments, updates and system bookkeeping reset it", () => {
    const moves: TaskMovement[] = [
      { at: minutes(25).getTime(), actorType: "agent", actorId: AGENT, action: "issue.comment_added" },
      { at: minutes(22).getTime(), actorType: "agent", actorId: AGENT, action: "issue.updated" },
      { at: minutes(15).getTime(), actorType: "system", actorId: "heartbeat", action: "issue.updated" },
      { at: minutes(12).getTime(), actorType: "system", actorId: null },
      // The agent's own work-product update is its bookkeeping, not a PR event.
      { at: minutes(8).getTime(), actorType: "agent", actorId: AGENT, action: "issue.work_product_updated" },
    ];
    expect(countContinuationsWithoutExternalInput({ agentId: AGENT, runs: runsAt(30, 20, 10), moves })).toBe(3);
  });

  it.each<[string, TaskMovement]>([
    ["a user comment", { at: minutes(15).getTime(), actorType: "user", actorId: "user-1", action: "issue.comment_added" }],
    ["a comment by a different agent", { at: minutes(15).getTime(), actorType: "agent", actorId: OTHER_AGENT }],
    ["a status change by a user", { at: minutes(15).getTime(), actorType: "user", actorId: "user-1", action: "issue.updated" }],
    ["a status change by a different agent", { at: minutes(15).getTime(), actorType: "agent", actorId: OTHER_AGENT, action: "issue.updated" }],
    ["a resolved blocker", { at: minutes(15).getTime(), actorType: "system", actorId: "system", action: "issue.blockers_resolved_wake_emitted" }],
    ["a PR sync event", { at: minutes(15).getTime(), actorType: "system", actorId: "pr-sync", action: "myrmidon.task_pr_sync.settled" }],
  ])("restarts the count after %s", (_label, move) => {
    // Only the runs at 20 and 30 minutes are newer than the external event at 15.
    expect(countContinuationsWithoutExternalInput({ agentId: AGENT, runs: runsAt(30, 20, 10), moves: [move] })).toBe(2);
  });

  it("counts nothing when the external event is newer than every run", () => {
    const move: TaskMovement = { at: minutes(40).getTime(), actorType: "user", actorId: "user-1", action: "issue.comment_added" };
    expect(countContinuationsWithoutExternalInput({ agentId: AGENT, runs: runsAt(30, 20, 10), moves: [move] })).toBe(0);
  });

  it("uses the latest external event when there are several", () => {
    const moves: TaskMovement[] = [
      { at: minutes(5).getTime(), actorType: "user", actorId: "user-1", action: "issue.comment_added" },
      { at: minutes(25).getTime(), actorType: "user", actorId: "user-1", action: "issue.comment_added" },
    ];
    // Only the run at 30 minutes is newer than the latest event at 25.
    expect(countContinuationsWithoutExternalInput({ agentId: AGENT, runs: runsAt(30, 20, 10), moves })).toBe(1);
  });

  it("reaches the cap after three runs in a row", () => {
    expect(MAX_CONTINUATIONS_WITHOUT_EXTERNAL_INPUT).toBe(3);
  });
});

describe("buildContinuationCapBlockedPatch", () => {
  const now = new Date("2026-11-06T08:00:00.000Z");

  it("parks the issue as blocked with a stated reason the issue service accepts", () => {
    const patch = buildContinuationCapBlockedPatch({
      issueId: "issue-1",
      assigneeAgentId: AGENT,
      ownerUserId: "user-1",
      now,
    });
    expect(patch.status).toBe("blocked");
    expect(patch.blockerMetadata).toMatchObject({
      blockReason: "human_decision",
      owner: { userId: "user-1" },
      externalRef: "continuation_cap:issue-1",
    });
    expect(patch.unblockDescriptor).toMatchObject({ owner: "board" });
    expect(patch.unblockDescriptor.action.length).toBeGreaterThan(0);
  });

  it("falls back to the assignee as owner when no user is known", () => {
    const patch = buildContinuationCapBlockedPatch({ issueId: "issue-1", assigneeAgentId: AGENT, now });
    expect(patch.blockerMetadata).toMatchObject({ owner: { agentId: AGENT } });
  });

  it("states the stop in Russian with the cap and the way out", () => {
    expect(CONTINUATION_CAP_COMMENT).toContain("Остановлено: 3 продолжения подряд без внешнего события");
    expect(CONTINUATION_CAP_COMMENT).toContain("Нужна новая вводная");
  });
});
