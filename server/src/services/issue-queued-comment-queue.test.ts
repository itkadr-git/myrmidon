import { describe, expect, it } from "vitest";
import {
  buildQueuedCommentQueueSnapshot,
  decideQueuedCommentQueueSteering,
  queuedCommentIdsFromWakePayload,
  queuedCommentIdsFromRunContext,
  withQueuedCommentIdsInWakePayload,
  withQueuedCommentIdsInRunContext,
} from "./issue-queued-comment-queue.js";

describe("queuedCommentIdsFromWakePayload and runContext", () => {
  it("filters out invalid or malformed comment IDs from wake payload", () => {
    const validUuid = "123e4567-e89b-12d3-a456-426614174000";
    const payload = {
      _paperclipWakeContext: {
        wakeCommentIds: [
          validUuid,
          "comment-1",
          "",
          "   ",
          null,
          123,
          validUuid, // duplicate
        ],
      },
    };

    expect(queuedCommentIdsFromWakePayload(payload)).toEqual([validUuid, "comment-1"]);
  });

  it("filters out invalid comment IDs from run context", () => {
    const validUuid = "123e4567-e89b-12d3-a456-426614174000";
    const context = {
      wakeCommentIds: [
        "",
        "   ",
        "comment-1",
        validUuid,
      ],
    };

    expect(queuedCommentIdsFromRunContext(context)).toEqual(["comment-1", validUuid]);
  });

  it("filters out invalid comment IDs when writing wake payload", () => {
    const validUuid = "123e4567-e89b-12d3-a456-426614174000";
    const resWithMalformed = withQueuedCommentIdsInWakePayload({}, ["", "   "]);
    expect(resWithMalformed.commentId).toBeUndefined();
    expect((resWithMalformed._paperclipWakeContext as Record<string, unknown>).wakeCommentIds).toBeUndefined();

    const resWithValid = withQueuedCommentIdsInWakePayload({}, ["   ", validUuid]);
    expect(resWithValid.commentId).toBe(validUuid);
    expect((resWithValid._paperclipWakeContext as Record<string, unknown>).wakeCommentIds).toEqual([validUuid]);
  });

  it("filters out invalid comment IDs when writing run context", () => {
    const validUuid = "123e4567-e89b-12d3-a456-426614174000";
    const resWithMalformed = withQueuedCommentIdsInRunContext({}, ["", "   "]);
    expect(resWithMalformed.commentId).toBeUndefined();
    expect(resWithMalformed.wakeCommentIds).toBeUndefined();

    const resWithValid = withQueuedCommentIdsInRunContext({}, ["   ", validUuid]);
    expect(resWithValid.commentId).toBe(validUuid);
    expect(resWithValid.wakeCommentIds).toEqual([validUuid]);
  });
});

describe("decideQueuedCommentQueueSteering", () => {
  it("answers unsupported on the legacy protocol", () => {
    const decision = decideQueuedCommentQueueSteering({
      state: "deferred",
      queueRunRuntimeMode: null,
      activeRun: { id: "run-1", runtimeMode: "legacy" },
      assignedAgentAdapterType: "codex_local",
      queuedCommentCount: 1,
    });

    expect(decision).toEqual({ protocol: "legacy", kind: "unsupported" });
  });

  it("answers temporarily_unavailable for a promoted native queue with no deferred run", () => {
    const decision = decideQueuedCommentQueueSteering({
      state: "queued",
      queueRunRuntimeMode: "native",
      activeRun: null,
      assignedAgentAdapterType: "paperclip_runner",
      queuedCommentCount: 1,
    });

    expect(decision).toEqual({ protocol: "paperclip_runner_v1", kind: "temporarily_unavailable" });
  });

  it("answers temporarily_unavailable when the queue holds no live comments", () => {
    const decision = decideQueuedCommentQueueSteering({
      state: "deferred",
      queueRunRuntimeMode: null,
      activeRun: { id: "run-1", runtimeMode: "native" },
      assignedAgentAdapterType: "paperclip_runner",
      queuedCommentCount: 0,
    });

    expect(decision).toEqual({ protocol: "paperclip_runner_v1", kind: "temporarily_unavailable" });
  });

  it("tells the caller it may probe a running deferred turn on the native protocol", () => {
    const decision = decideQueuedCommentQueueSteering({
      state: "deferred",
      queueRunRuntimeMode: null,
      activeRun: { id: "run-1", runtimeMode: "native" },
      assignedAgentAdapterType: "paperclip_runner",
      queuedCommentCount: 1,
    });

    expect(decision).toEqual({ protocol: "paperclip_runner_v1", kind: "probe", steeringRunId: "run-1" });
  });

  // Acceptance-criterion fact pattern: a deferred queue whose active run
  // has not resolved a runtime mode yet, for an agent on the
  // `paperclip_runner` adapter. The protocol resolves to
  // `paperclip_runner_v1` through the adapter-type fallback, and the
  // decision hands the run to the caller to probe live — it never answers
  // the flat "unsupported" value a duplicated, unshared rule can drift to.
  it("resolves the protocol through the adapter-type fallback and asks the caller to probe", () => {
    const decision = decideQueuedCommentQueueSteering({
      state: "deferred",
      queueRunRuntimeMode: null,
      activeRun: { id: "run-1", runtimeMode: null },
      assignedAgentAdapterType: "paperclip_runner",
      queuedCommentCount: 1,
    });

    expect(decision).toEqual({ protocol: "paperclip_runner_v1", kind: "probe", steeringRunId: "run-1" });
  });
});

describe("buildQueuedCommentQueueSnapshot entry permissions", () => {
  const baseFacts = {
    issueId: "issue-1",
    queueId: "queue-1",
    state: "queued" as const,
    activeRunId: null,
    protocol: "legacy" as const,
    steeringDisposition: "unsupported" as const,
  };

  it("grants edit and discard to the user who authored the queued comment", () => {
    const queue = buildQueuedCommentQueueSnapshot({
      ...baseFacts,
      actorType: "user",
      actorId: "user-1",
      comments: [{ id: "comment-1", updatedAt: new Date(), authorUserId: "user-1" }],
    });

    expect(queue.entries[0]?.canEdit).toBe(true);
    expect(queue.entries[0]?.canDiscard).toBe(true);
  });

  it("denies edit and discard to a user who did not author the queued comment", () => {
    const queue = buildQueuedCommentQueueSnapshot({
      ...baseFacts,
      actorType: "user",
      actorId: "user-1",
      comments: [{ id: "comment-1", updatedAt: new Date(), authorUserId: "user-2" }],
    });

    expect(queue.entries[0]?.canEdit).toBe(false);
    expect(queue.entries[0]?.canDiscard).toBe(false);
  });

  it("denies edit and discard to an agent actor even when the comment carries a matching author id", () => {
    const queue = buildQueuedCommentQueueSnapshot({
      ...baseFacts,
      actorType: "agent",
      actorId: "user-1",
      comments: [{ id: "comment-1", updatedAt: new Date(), authorUserId: "user-1" }],
    });

    expect(queue.entries[0]?.canEdit).toBe(false);
    expect(queue.entries[0]?.canDiscard).toBe(false);
  });
});
