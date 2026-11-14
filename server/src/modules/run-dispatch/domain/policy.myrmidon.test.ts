import { describe, expect, it } from "vitest";
import { decideQueuedRunStaleness, type QueuedRunFacts } from "./policy.js";
import { looksLikePendingInteractionAddresseeWake } from "../myrmidon-pending-interaction-wake.js";

const NOW = new Date("2026-09-01T00:00:00.000Z");

function facts(overrides: Partial<QueuedRunFacts> = {}): QueuedRunFacts {
  return {
    runId: "run-a",
    runAgentId: "agent-b",
    issueId: "issue-a",
    retryReasonKind: "other",
    issueFound: true,
    issueStatus: "in_progress",
    issueAssigneeAgentId: "agent-a",
    issueExecutionRunId: null,
    isResolvedInteractionContinuation: false,
    isInteractionWake: false,
    isAuthorizedSourceScopedRecovery: false,
    isProductiveContinuationRecovery: false,
    isNonAssigneeWorkspaceBusyRetry: false,
    resumeIntent: false,
    wakeCommentIdPresent: false,
    continuationParkApplies: false,
    continuationParksExecutor: false,
    continuationSummaryBody: null,
    wakeReason: "interaction_pending",
    retryReason: null,
    reviewParticipant: {
      isInReview: false,
      hasParticipant: false,
      participantIsAgent: false,
      participantAgentId: null,
      currentStageType: null,
      currentParticipant: null,
    },
    ...overrides,
  };
}

describe("decideQueuedRunStaleness: pending interaction addressee (P2)", () => {
  it("does not treat the addressee wake of a non-assignee as stale", () => {
    expect(decideQueuedRunStaleness(facts({ isPendingInteractionAddresseeWake: true }), NOW)).toEqual({
      stale: false,
    });
  });

  it("still cancels a non-assignee wake without the addressee signal", () => {
    expect(decideQueuedRunStaleness(facts(), NOW)).toMatchObject({
      stale: true,
      errorCode: "issue_assignee_changed",
    });
  });

  // myrmidon(N2): a card that is still pending outlives the status flip that
  // closed the task it was opened on, so the addressee's run answers it
  // instead of being cancelled as terminal.
  it("bypasses a terminal issue status for a pending card's addressee", () => {
    for (const issueStatus of ["done", "cancelled"]) {
      expect(
        decideQueuedRunStaleness(facts({ isPendingInteractionAddresseeWake: true, issueStatus }), NOW),
      ).toEqual({ stale: false });
    }
  });

  it("still cancels a terminal issue for a wake that is not a card addressee", () => {
    expect(
      decideQueuedRunStaleness(facts({ isInteractionWake: true, issueStatus: "done" }), NOW),
    ).toMatchObject({ stale: true, errorCode: "issue_terminal_status" });
  });
});

describe("decideQueuedRunStaleness: productive continuation recovery", () => {
  it("allows the source-scoped recovery run to start after assignment changed", () => {
    expect(
      decideQueuedRunStaleness(
        facts({
          issueAssigneeAgentId: "new-agent",
          isProductiveContinuationRecovery: true,
          wakeReason: "issue_continuation_needed",
          retryReason: "issue_continuation_needed",
        }),
        NOW,
      ),
    ).toEqual({ stale: false });
  });

  it("does not allow an ordinary continuation wake to bypass ownership", () => {
    expect(
      decideQueuedRunStaleness(
        facts({
          issueAssigneeAgentId: "new-agent",
          wakeReason: "issue_continuation_needed",
          retryReason: "issue_continuation_needed",
        }),
        NOW,
      ),
    ).toMatchObject({ stale: true, errorCode: "issue_assignee_changed" });
  });
});

// myrmidon(RUN-GUARD-ESCALATE): the manager woken after a final run guard stop is not the
// assignee, and the issue is blocked: the wake must still start.
describe("decideQueuedRunStaleness: run guard stop needs input (RUN-GUARD-ESCALATE)", () => {
  const managerWake = (overrides: Partial<QueuedRunFacts> = {}) =>
    facts({
      runAgentId: "manager",
      issueAssigneeAgentId: "agent-a",
      issueStatus: "blocked",
      wakeReason: "run_guard_stop_needs_input",
      ...overrides,
    });

  it("lets the wake of a non-assignee manager start on the blocked issue", () => {
    expect(decideQueuedRunStaleness(managerWake({ isRunGuardStopNeedsInputWake: true }), NOW)).toEqual({
      stale: false,
    });
  });

  it("still cancels the same wake when it does not carry the run guard signal", () => {
    expect(decideQueuedRunStaleness(managerWake(), NOW)).toMatchObject({
      stale: true,
      errorCode: "issue_assignee_changed",
    });
  });

  it("still cancels it once the issue reached a terminal status", () => {
    expect(
      decideQueuedRunStaleness(managerWake({ isRunGuardStopNeedsInputWake: true, issueStatus: "done" }), NOW),
    ).toMatchObject({ stale: true, errorCode: "issue_terminal_status" });
  });
});

describe("decideQueuedRunStaleness: block owner unblock wake (UNBLOCK-OWNER-WAKE)", () => {
  const ownerWake = (overrides: Partial<QueuedRunFacts> = {}) =>
    facts({
      runAgentId: "senior",
      issueAssigneeAgentId: "agent-a",
      issueStatus: "blocked",
      wakeReason: "issue_unblock_requested",
      ...overrides,
    });

  it("lets the non-assignee block owner start on the blocked issue", () => {
    expect(decideQueuedRunStaleness(ownerWake({ isUnblockOwnerWake: true }), NOW)).toEqual({ stale: false });
  });

  it("still cancels the same wake without the block owner signal", () => {
    expect(decideQueuedRunStaleness(ownerWake(), NOW)).toMatchObject({
      stale: true,
      errorCode: "issue_assignee_changed",
    });
  });

  it("still cancels it once the issue reached a terminal status", () => {
    expect(
      decideQueuedRunStaleness(ownerWake({ isUnblockOwnerWake: true, issueStatus: "done" }), NOW),
    ).toMatchObject({ stale: true, errorCode: "issue_terminal_status" });
  });
});

// myrmidon(OPE-11948): a queued automatic continuation dies when the issue was
// parked or sent to review after the wake was created.
describe("decideQueuedRunStaleness: automatic continuation wake (OPE-11948)", () => {
  const continuation = (overrides: Partial<QueuedRunFacts> = {}) =>
    facts({
      issueAssigneeAgentId: "agent-b",
      isAutomaticContinuationWake: true,
      wakeReason: "issue_continuation_needed",
      retryReason: "issue_continuation_needed",
      ...overrides,
    });

  it.each(["blocked", "in_review"])("cancels the queued run when the issue is %s", (issueStatus) => {
    expect(decideQueuedRunStaleness(continuation({ issueStatus }), NOW)).toMatchObject({
      stale: true,
      errorCode: "issue_not_in_progress",
    });
  });

  it.each(["todo", "in_progress"])("starts the run while the issue is %s", (issueStatus) => {
    expect(decideQueuedRunStaleness(continuation({ issueStatus }), NOW)).toEqual({ stale: false });
  });

  it("keeps the other terminal and backlog codes", () => {
    expect(decideQueuedRunStaleness(continuation({ issueStatus: "done" }), NOW)).toMatchObject({
      stale: true,
      errorCode: "issue_terminal_status",
    });
    expect(decideQueuedRunStaleness(continuation({ issueStatus: "backlog" }), NOW)).toMatchObject({
      stale: true,
      errorCode: "queued_run_issue_not_startable",
    });
  });

  it("does not touch a continuation that is not an automatic wake (explicit resume, comment)", () => {
    expect(
      decideQueuedRunStaleness(
        continuation({ issueStatus: "blocked", isAutomaticContinuationWake: false, resumeIntent: true }),
        NOW,
      ),
    ).toEqual({ stale: false });
  });

  it("does not touch other wake reasons on a blocked issue", () => {
    expect(
      decideQueuedRunStaleness(
        facts({ issueAssigneeAgentId: "agent-b", issueStatus: "blocked", wakeReason: "issue_commented" }),
        NOW,
      ),
    ).toEqual({ stale: false });
  });
});

describe("looksLikePendingInteractionAddresseeWake", () => {
  const interactionId = "3f2b6a4e-1c7d-4e8f-9a0b-5c6d7e8f9a0b";

  it("matches the wake sent on interaction creation", () => {
    expect(
      looksLikePendingInteractionAddresseeWake({
        wakeReason: "interaction_pending",
        source: "issue.interaction.created",
        interactionId,
      }),
    ).toBe(true);
  });

  it("rejects other reasons, other sources and malformed interaction ids", () => {
    expect(
      looksLikePendingInteractionAddresseeWake({ wakeReason: "issue_commented", source: "issue.interaction.created", interactionId }),
    ).toBe(false);
    expect(
      looksLikePendingInteractionAddresseeWake({ wakeReason: "interaction_pending", source: "automation", interactionId }),
    ).toBe(false);
    expect(
      looksLikePendingInteractionAddresseeWake({
        wakeReason: "interaction_pending",
        source: "issue.interaction.created",
        interactionId: "not-a-uuid",
      }),
    ).toBe(false);
  });
});

// myrmidon(RUN-SETUP-STALE-TASK / CLOSED-TASK-COMMENT-RUN)
describe("decideQueuedRunStaleness: assignment wake of a task closed before the start", () => {
  const assigned = { runAgentId: "agent-a", wakeReason: "issue_assigned", wakeCommentIdPresent: true };

  it("cancels an issue_assigned run as terminal even though it carries the hand-off comment", () => {
    for (const issueStatus of ["done", "cancelled"]) {
      expect(decideQueuedRunStaleness(facts({ ...assigned, issueStatus }), NOW)).toMatchObject({
        stale: true,
        errorCode: "issue_terminal_status",
      });
    }
  });

  it("cancels an assignee comment wake of a closed task as terminal", () => {
    for (const issueStatus of ["done", "cancelled"]) {
      expect(
        decideQueuedRunStaleness(
          facts({ ...assigned, wakeReason: "issue_commented", issueStatus }),
          NOW,
        ),
      ).toMatchObject({
        stale: true,
        errorCode: "issue_terminal_status",
      });
    }
  });

  it("still lets a non-assignee comment wake of a closed task start", () => {
    expect(
      decideQueuedRunStaleness(
        facts({
          runAgentId: "agent-b",
          issueAssigneeAgentId: "agent-a",
          isInteractionWake: true,
          wakeCommentIdPresent: true,
          wakeReason: "issue_commented",
          issueStatus: "done",
        }),
        NOW,
      ),
    ).toEqual({ stale: false });
  });

  it("still lets a comment wake start if resumeIntent is true", () => {
    expect(
      decideQueuedRunStaleness(
        facts({
          ...assigned,
          wakeReason: "issue_commented",
          issueStatus: "done",
          resumeIntent: true,
        }),
        NOW,
      ),
    ).toEqual({ stale: false });
  });

  it("does not cancel an issue_assigned run of an open task", () => {
    expect(decideQueuedRunStaleness(facts({ ...assigned }), NOW)).toEqual({ stale: false });
  });
});
