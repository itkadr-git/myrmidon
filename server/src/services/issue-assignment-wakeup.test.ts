import { describe, expect, it, vi } from "vitest";
import {
  queueIssueAssignmentWakeup,
  type IssueAssignmentWakeupDeps,
} from "./issue-assignment-wakeup.js";

// myrmidon(1.8 HIBERNATE, OPE-12961): a ready assigned task goes through the
// standard assignment wakeup; a not-ready task (backlog / closed / no
// assignee) must not wake anyone.
const readyIssue = {
  id: "issue-1",
  assigneeAgentId: "agent-1",
  status: "todo",
};

type WakeupFn = IssueAssignmentWakeupDeps["wakeup"];

function heartbeatWith(wakeup?: WakeupFn) {
  const fn =
    wakeup ??
    vi.fn<WakeupFn>(async () => ({ id: "run-1" }));
  return { heartbeat: { wakeup: fn }, wakeup: fn };
}

describe("queueIssueAssignmentWakeup (OPE-12961)", () => {
  it("wakes the assignee of a ready assigned task through the assignment path", async () => {
    const { heartbeat, wakeup } = heartbeatWith();
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: readyIssue,
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
    });
    expect(wakeup).toHaveBeenCalledTimes(1);
    const [agentId, opts] = wakeup.mock.calls[0] as [string, Record<string, unknown>];
    expect(agentId).toBe("agent-1");
    expect(opts.source).toBe("assignment");
    expect(opts.reason).toBe("issue_assigned");
    expect(opts.payload).toMatchObject({ issueId: "issue-1", mutation: "create" });
  });

  it.each([
    ["backlog task", { ...readyIssue, status: "backlog" }],
    ["done task", { ...readyIssue, status: "done" }],
    ["cancelled task", { ...readyIssue, status: "cancelled" }],
    ["task without assignee", { ...readyIssue, assigneeAgentId: null }],
  ])("does not wake for a not-ready task (%s)", async (_name, issue) => {
    const { heartbeat, wakeup } = heartbeatWith();
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue,
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
    });
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("forwards an already-running wake without throwing while it is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wakeup = vi.fn((_agentId: string, _opts: unknown) => gate);
    const queued = queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: readyIssue,
      reason: "issue_assigned",
      mutation: "update",
      contextSource: "issue.update",
    });
    // The wake is in flight; no second call is made at this layer. The
    // duplicate collapse itself lives in the single-flight guard
    // (wakeup-single-flight.test.ts).
    expect(wakeup).toHaveBeenCalledTimes(1);
    release();
    await expect(queued).resolves.toBeUndefined();
  });
});
