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
