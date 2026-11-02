import { describe, expect, it, vi } from "vitest";
import {
  continueDevReview,
  devProcessProjectIds,
  issueAuthorAgentId,
  tryDevReviewContinuationOnRelease,
} from "./review-continuation.js";

// Real production state: when an issue is moved to in_review with a review stage,
// assigneeAgentId becomes the reviewer, and the original author is stored in
// executionState.returnAssignee.
const realInReviewIssue = {
  id: "issue-a",
  companyId: "company-a",
  projectId: "project-a",
  status: "in_review",
  assigneeAgentId: "reviewer-1",
  executionState: {
    status: "pending",
    currentStageType: "review",
    returnAssignee: { type: "agent", agentId: "engineer-a", userId: null },
  },
};

function ports(pair: { issueId: string } | null = null) {
  return {
    match: vi.fn().mockResolvedValue({ enabled: true, pair }),
    signalLead: vi.fn().mockResolvedValue(undefined),
  };
}

describe("review continuation author extraction", () => {
  it("extracts author from executionState.returnAssignee when assignee is reviewer", () => {
    expect(issueAuthorAgentId(realInReviewIssue)).toBe("engineer-a");
  });

  it("handles executionState serialized as JSON string", () => {
    const issueWithStringState = {
      ...realInReviewIssue,
      executionState: JSON.stringify(realInReviewIssue.executionState),
    };
    expect(issueAuthorAgentId(issueWithStringState)).toBe("engineer-a");
  });

  it("falls back to assigneeAgentId when executionState has no returnAssignee", () => {
    const fallbackIssue = {
      id: "issue-b",
      companyId: "company-a",
      projectId: "project-a",
      status: "in_review",
      assigneeAgentId: "engineer-b",
      executionState: null,
    };
    expect(issueAuthorAgentId(fallbackIssue)).toBe("engineer-b");
  });
});

describe("dev review continuation", () => {
  it("picks the next task only in the reviewed dev project for the freed author", () => {
    const deps = ports({ issueId: "next-a" });
    return continueDevReview(deps, realInReviewIssue, "engineer-a", new Set(["project-a"])).then((handled) => {
      expect(handled).toBe(true);
      expect(deps.match).toHaveBeenCalledWith("engineer-a", {
        projectId: "project-a",
        excludeIssueId: "issue-a",
      });
      expect(deps.signalLead).not.toHaveBeenCalled();
    });
  });

  it("signals the lead when the scoped dev queue has no task", async () => {
    const deps = ports();
    const handled = await continueDevReview(deps, realInReviewIssue, "engineer-a", new Set(["project-a"]));
    expect(handled).toBe(true);
    expect(deps.signalLead).toHaveBeenCalledWith(realInReviewIssue, "engineer-a");
  });

  it("does not trigger continuation when released agent is the reviewer, not author", async () => {
    const deps = ports();
    const handled = await continueDevReview(deps, realInReviewIssue, "reviewer-1", new Set(["project-a"]));
    expect(handled).toBe(false);
    expect(deps.match).not.toHaveBeenCalled();
    expect(deps.signalLead).not.toHaveBeenCalled();
  });

  it.each([
    { ...realInReviewIssue, projectId: "other-project" },
    { ...realInReviewIssue, projectId: null },
    { ...realInReviewIssue, status: "in_progress" },
  ])("leaves non-dev releases unchanged: %j", async (source) => {
    const deps = ports();
    expect(await continueDevReview(deps, source, "engineer-a", new Set(["project-a"]))).toBe(false);
    expect(deps.match).not.toHaveBeenCalled();
    expect(deps.signalLead).not.toHaveBeenCalled();
  });

  it("does not report an empty queue when the matcher is disabled", async () => {
    const deps = ports();
    deps.match.mockResolvedValue({ enabled: false, pair: null });
    expect(await continueDevReview(deps, realInReviewIssue, "engineer-a", new Set(["project-a"]))).toBe(true);
    expect(deps.signalLead).not.toHaveBeenCalled();
  });
});

describe("tryDevReviewContinuationOnRelease integration", () => {
  it("handles release with next task in dev project", async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([realInReviewIssue]),
          }),
        }),
      }),
    };

    const matchFreedAgent = vi.fn().mockResolvedValue({ enabled: true, pair: { issueId: "task-next" } });
    const enqueueWakeup = vi.fn().mockResolvedValue(undefined);
    const logActivity = vi.fn().mockResolvedValue(undefined);

    const handled = await tryDevReviewContinuationOnRelease({
      db: mockDb as any,
      releasedRun: {
        id: "run-release-1",
        agentId: "engineer-a",
        companyId: "company-a",
        contextSnapshot: { issueId: "issue-a" },
      },
      currentRunId: "run-heartbeat-1",
      match: matchFreedAgent,
      enqueueWakeup,
      logActivity,
      enabledProjects: new Set(["project-a"]),
    });

    expect(handled).toBe(true);
    expect(matchFreedAgent).toHaveBeenCalledWith("engineer-a", {
      projectId: "project-a",
      excludeIssueId: "issue-a",
    });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("signals project lead when queue is empty on release", async () => {
    const mockDb = {
      select: vi.fn().mockImplementation((fields) => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(() => {
              if (fields?.leadAgentId !== undefined) {
                return Promise.resolve([{ leadAgentId: "lead-agent-1" }]);
              }
              return Promise.resolve([realInReviewIssue]);
            }),
          }),
        }),
      })),
    };

    const matchFreedAgent = vi.fn().mockResolvedValue({ enabled: true, pair: null });
    const enqueueWakeup = vi.fn().mockResolvedValue(undefined);
    const logActivity = vi.fn().mockResolvedValue(undefined);

    const handled = await tryDevReviewContinuationOnRelease({
      db: mockDb as any,
      releasedRun: {
        id: "run-release-2",
        agentId: "engineer-a",
        companyId: "company-a",
        contextSnapshot: { issueId: "issue-a" },
      },
      currentRunId: "run-heartbeat-2",
      match: matchFreedAgent,
      enqueueWakeup,
      logActivity,
      enabledProjects: new Set(["project-a"]),
    });

    expect(handled).toBe(true);
    expect(enqueueWakeup).toHaveBeenCalledWith(
      "lead-agent-1",
      expect.objectContaining({
        reason: "dev_project_queue_empty",
        payload: { issueId: "issue-a", projectId: "project-a", engineerId: "engineer-a" },
      }),
    );
    expect(logActivity).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        action: "dev_project.queue_unavailable",
        agentId: "engineer-a",
      }),
    );
  });

  it("returns false and does not match when releasedRun is for reviewer", async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([realInReviewIssue]),
          }),
        }),
      }),
    };

    const matchFreedAgent = vi.fn();
    const enqueueWakeup = vi.fn();

    const handled = await tryDevReviewContinuationOnRelease({
      db: mockDb as any,
      releasedRun: {
        id: "run-reviewer",
        agentId: "reviewer-1",
        companyId: "company-a",
        contextSnapshot: { issueId: "issue-a" },
      },
      currentRunId: "run-heartbeat-3",
      match: matchFreedAgent,
      enqueueWakeup,
      enabledProjects: new Set(["project-a"]),
    });

    expect(handled).toBe(false);
    expect(matchFreedAgent).not.toHaveBeenCalled();
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });
});
