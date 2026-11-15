import { describe, expect, it } from "vitest";
import {
  scheduledRetryPromotedEventCommand,
  scheduledRetrySuppressedEventCommand,
  staleQueuedRunCancelledEventCommand,
  type RunEventIdentity,
} from "./run-event-command.js";

const RUN: RunEventIdentity = {
  companyId: "company-1",
  runId: "run-1",
  agentId: "agent-1",
};

const RETRY_RUN = {
  ...RUN,
  scheduledRetryAttempt: 2,
  scheduledRetryAt: new Date("2026-01-01T00:00:00.000Z"),
  scheduledRetryReason: "max_turns_continuation",
};

describe("scheduledRetryPromotedEventCommand", () => {
  it("maps a promotion decision onto an info lifecycle command without a receipt", () => {
    expect(scheduledRetryPromotedEventCommand(RETRY_RUN)).toEqual({
      run: { companyId: "company-1", runId: "run-1", agentId: "agent-1" },
      level: "info",
      message: "Scheduled retry became due and was promoted to the queued run pool",
      payload: {
        scheduledRetryAttempt: 2,
        scheduledRetryAt: "2026-01-01T00:00:00.000Z",
        scheduledRetryReason: "max_turns_continuation",
      },
      activityReceipt: null,
    });
  });

  it("renders a missing scheduledRetryAt as null, not an Invalid Date", () => {
    const command = scheduledRetryPromotedEventCommand({
      ...RUN,
      scheduledRetryAttempt: 0,
      scheduledRetryAt: null,
      scheduledRetryReason: null,
    });
    expect(command.payload.scheduledRetryAt).toBeNull();
    expect(command.payload.scheduledRetryReason).toBeNull();
  });

  it("is deterministic: the same fixture yields the same command", () => {
    expect(scheduledRetryPromotedEventCommand(RETRY_RUN)).toEqual(
      scheduledRetryPromotedEventCommand(RETRY_RUN),
    );
  });
});

describe("scheduledRetrySuppressedEventCommand", () => {
  it("carries the gate reason at warn level with the retry facts merged in", () => {
    const command = scheduledRetrySuppressedEventCommand(RETRY_RUN, {
      reason: "agent paused",
      details: { agentId: "agent-1" },
    });
    expect(command.level).toBe("warn");
    expect(command.message).toBe("agent paused");
    expect(command.payload).toEqual({
      agentId: "agent-1",
      scheduledRetryAttempt: 2,
      scheduledRetryAt: "2026-01-01T00:00:00.000Z",
      scheduledRetryReason: "max_turns_continuation",
    });
    expect(command.activityReceipt).toBeNull();
  });

  it("lets retry facts overwrite colliding gate details (original spread order)", () => {
    const command = scheduledRetrySuppressedEventCommand(RETRY_RUN, {
      reason: "gate reason",
      details: { scheduledRetryReason: "gate wins" },
    });
    expect(command.payload.scheduledRetryReason).toBe("max_turns_continuation");
  });
});

describe("staleQueuedRunCancelledEventCommand", () => {
  it("maps a staleness decision onto a warn event plus an activity receipt", () => {
    const decision = {
      stale: true as const,
      errorCode: "issue_assignee_changed",
      reason: "issue was reassigned",
      details: { issueId: "issue-1" },
    };
    expect(staleQueuedRunCancelledEventCommand(RUN, decision)).toEqual({
      run: { companyId: "company-1", runId: "run-1", agentId: "agent-1" },
      level: "warn",
      message: "issue was reassigned",
      payload: { issueId: "issue-1" },
      activityReceipt: {
        actorId: "queued-run-timeout",
        action: "heartbeat_run.cancelled",
        entityType: "heartbeat_run",
        entityId: "run-1",
        details: {
          reason: "issue was reassigned",
          errorCode: "issue_assignee_changed",
          issueId: "issue-1",
        },
      },
    });
  });
});
