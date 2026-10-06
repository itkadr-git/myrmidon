import { describe, expect, it } from "vitest";
import {
  continuationOriginCommentIds,
  readExecutionContinuation,
} from "./execution-continuation.js";

// PERF-DIET: the execution continuation envelope is stored once, inside
// paperclipWake. These cases pin the accessor that keeps the resume path,
// the origin-comment tracking and the completion feedback working while rows
// written before the dedupe migration are still being cleaned.
describe("readExecutionContinuation", () => {
  it("reads the canonical copy from the wake payload", () => {
    const envelope = { objective: "ship it", originCommentIds: ["comment-1"] };
    expect(
      readExecutionContinuation({
        paperclipWake: { executionContinuation: envelope },
      }),
    ).toEqual(envelope);
  });

  it("falls back to the legacy top-level copy until the migration strips it", () => {
    const envelope = { objective: "ship it" };
    expect(readExecutionContinuation({ executionContinuation: envelope })).toEqual(
      envelope,
    );
  });

  it("prefers the wake payload when a snapshot still carries both copies", () => {
    expect(
      readExecutionContinuation({
        executionContinuation: { objective: "stale duplicate" },
        paperclipWake: { executionContinuation: { objective: "canonical" } },
      }),
    ).toEqual({ objective: "canonical" });
  });

  it("returns an empty envelope when the snapshot carries none", () => {
    expect(readExecutionContinuation(null)).toEqual({});
    expect(readExecutionContinuation({ issueId: "issue-1" })).toEqual({});
    expect(
      readExecutionContinuation({ paperclipWake: { reason: "issue_assigned" } }),
    ).toEqual({});
    expect(readExecutionContinuation({ paperclipWake: "not-an-object" })).toEqual({});
  });

  it("keeps origin comments readable across the stored shape", () => {
    expect(
      continuationOriginCommentIds({
        commentId: "comment-1",
        paperclipWake: {
          executionContinuation: { originCommentIds: ["comment-2"] },
        },
      }),
    ).toEqual(["comment-1", "comment-2"]);
    expect(
      continuationOriginCommentIds({
        executionContinuation: { originCommentIds: ["comment-3"] },
      }),
    ).toEqual(["comment-3"]);
  });
});
