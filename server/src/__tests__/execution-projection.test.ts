import { describe, expect, it } from "vitest";
import {
  projectExecution,
  sanitizeExecutionProjectionForActor,
} from "../services/execution-projection.js";
import type { ExecutionProjection } from "@myrmidon/shared";

describe("execution projection operatorActions and actor sanitization", () => {
  it("projects execution with operatorActions and without permittedActions", () => {
    const run = {
      id: "run-1",
      errorCode: null,
      executionControlDeadlineAt: null,
      finishedAt: null,
      lastOutputAt: null,
      lastUsefulActionAt: null,
      nativeIssueId: "issue-1",
      nextAction: null,
      processPid: null,
      retryOfRunId: null,
      runtimeMode: "native" as const,
      scheduledRetryAt: null,
      scheduledRetryAttempt: null,
      scheduledRetryReason: null,
      startedAt: new Date("2026-10-30T10:00:00Z"),
      status: "running",
      contextSnapshot: { issueId: "issue-1" },
    };

    const projection = projectExecution(
      run,
      {
        phase: "observed",
        leaseExpiresAt: new Date(Date.now() + 60000),
      } as any,
      [],
      undefined,
      new Date(),
    );

    expect(projection.operatorActions).toEqual(["inspect_run"]);
    expect((projection as any).permittedActions).toBeUndefined();
    expect(projection.phase).toBe("working");
  });

  it("appends inspect_recovery to operatorActions when recovery is needed", () => {
    const run = {
      id: "run-1",
      errorCode: "execution_failed",
      executionControlDeadlineAt: null,
      finishedAt: new Date("2026-10-30T10:05:00Z"),
      lastOutputAt: null,
      lastUsefulActionAt: null,
      nativeIssueId: "issue-1",
      nextAction: null,
      processPid: null,
      retryOfRunId: null,
      runtimeMode: "native" as const,
      scheduledRetryAt: null,
      scheduledRetryAttempt: null,
      scheduledRetryReason: null,
      startedAt: new Date("2026-10-30T10:00:00Z"),
      status: "failed",
      contextSnapshot: { issueId: "issue-1" },
    };

    const recoveryAction = {
      issueId: "issue-1",
      cause: "uncertain_provider_action",
      nextAction: "reconcile",
      status: "active",
      evidence: {},
    };

    const projection = projectExecution(
      run,
      { phase: "terminal_failure" } as any,
      [],
      recoveryAction as any,
      new Date(),
    );

    expect(projection.phase).toBe("recovery_needed");
    expect(projection.operatorActions).toEqual(["inspect_run", "inspect_recovery"]);
    expect((projection as any).permittedActions).toBeUndefined();
  });

  it("omits operatorActions and permittedActions for agent actors", () => {
    const projection: ExecutionProjection = {
      phase: "working",
      label: "Working",
      cause: null,
      lastConfirmedActivityAt: null,
      retryAt: null,
      attempt: 1,
      maxAttempts: 3,
      recoveryOwner: null,
      nextAction: null,
      operatorActions: ["inspect_run"],
      predecessorRunId: null,
      successorRunId: null,
    };

    const sanitized = sanitizeExecutionProjectionForActor(projection, {
      type: "agent",
    });

    expect(sanitized).toBeDefined();
    expect(sanitized).not.toHaveProperty("permittedActions");
    expect(sanitized).not.toHaveProperty("operatorActions");
    expect(sanitized?.phase).toBe("working");
    expect(sanitized?.attempt).toBe(1);
  });

  it("preserves operatorActions and removes legacy permittedActions for board actors", () => {
    const projection = {
      phase: "working" as const,
      label: "Working",
      cause: null,
      lastConfirmedActivityAt: null,
      retryAt: null,
      attempt: 1,
      maxAttempts: 3,
      recoveryOwner: null,
      nextAction: null,
      operatorActions: ["inspect_run" as const],
      permittedActions: ["inspect_run"],
      predecessorRunId: null,
      successorRunId: null,
    };

    const sanitized = sanitizeExecutionProjectionForActor(projection as any, {
      type: "board",
    });

    expect(sanitized).toBeDefined();
    expect(sanitized).not.toHaveProperty("permittedActions");
    expect(sanitized?.operatorActions).toEqual(["inspect_run"]);
    expect(sanitized?.phase).toBe("working");
  });
});
