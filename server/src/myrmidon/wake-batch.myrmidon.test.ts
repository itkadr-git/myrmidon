// The wake batch window is pure decision logic: which queued run waits for the
// rest of its window, for how long, and when the resweep that starts it is
// asked for. The decisions and the configuration are pinned down here; the
// dispatch that applies them (`startNextQueuedRunForAgent` in
// server/src/services/heartbeat.ts) keeps the ordinary queued-run behaviour —
// a held run stays `queued` and is started by the resweep.
import { describe, expect, it } from "vitest";
import {
  COMMENT_WAKE_REASONS,
  DEFAULT_WAKE_BATCH_WINDOW_MS,
  MAX_WAKE_BATCH_WINDOW_MS,
  MIN_WAKE_BATCH_WINDOW_MS,
  WAKE_BATCH_WINDOW_ENV,
  classifyWakeBatchEligibility,
  decideWakeBatchHold,
  readWakeBatchWindowMs,
  splitBatchedWakeRuns,
} from "./wake-batch.js";
import { WAKE_COMMENT_IDS_KEY } from "../modules/run-dispatch/index.js";

const windowMs = 10_000;
const now = new Date("2026-10-09T10:00:00.000Z");

function commentWakeContext(overrides: Record<string, unknown> = {}) {
  return {
    issueId: "issue-1",
    wakeReason: "issue_commented",
    source: "issue-comment",
    commentId: "comment-1",
    [WAKE_COMMENT_IDS_KEY]: ["comment-1"],
    ...overrides,
  };
}

function queuedRun(input: {
  id: string;
  createdAt: Date;
  contextSnapshot?: unknown;
}) {
  return {
    id: input.id,
    createdAt: input.createdAt,
    contextSnapshot: input.contextSnapshot ?? commentWakeContext(),
  };
}

describe("wake batch window configuration", () => {
  it("ships the window off when nothing is configured", () => {
    expect(readWakeBatchWindowMs({})).toBe(DEFAULT_WAKE_BATCH_WINDOW_MS);
    expect(readWakeBatchWindowMs({ [WAKE_BATCH_WINDOW_ENV]: "" })).toBe(
      DEFAULT_WAKE_BATCH_WINDOW_MS,
    );
  });

  it("reads a configured window in milliseconds", () => {
    expect(readWakeBatchWindowMs({ [WAKE_BATCH_WINDOW_ENV]: "30000" })).toBe(30_000);
    expect(readWakeBatchWindowMs({ [WAKE_BATCH_WINDOW_ENV]: " 1500 " })).toBe(1_500);
  });

  it("treats zero, off, false and no as the feature switched off", () => {
    for (const raw of ["0", "off", "OFF", "false", "no"]) {
      expect(readWakeBatchWindowMs({ [WAKE_BATCH_WINDOW_ENV]: raw })).toBe(0);
    }
  });

  it("falls back to the default on an unparsable value and caps an oversized one", () => {
    expect(readWakeBatchWindowMs({ [WAKE_BATCH_WINDOW_ENV]: "soon" })).toBe(
      DEFAULT_WAKE_BATCH_WINDOW_MS,
    );
    expect(readWakeBatchWindowMs({ [WAKE_BATCH_WINDOW_ENV]: "-5" })).toBe(
      DEFAULT_WAKE_BATCH_WINDOW_MS,
    );
    expect(readWakeBatchWindowMs({ [WAKE_BATCH_WINDOW_ENV]: "600000" })).toBe(
      MAX_WAKE_BATCH_WINDOW_MS,
    );
    // A window shorter than the resweep resolution is raised, not honoured.
    expect(readWakeBatchWindowMs({ [WAKE_BATCH_WINDOW_ENV]: "10" })).toBe(
      MIN_WAKE_BATCH_WINDOW_MS,
    );
  });
});

describe("wake batch eligibility", () => {
  it("accepts a comment wake and keeps its ids in the order they arrived", () => {
    const ids = ["comment-3", "comment-1", "comment-2"];
    const eligibility = classifyWakeBatchEligibility(
      commentWakeContext({ [WAKE_COMMENT_IDS_KEY]: ids }),
    );
    expect(eligibility).toEqual({ eligible: true, commentIds: ids });
  });

  it("accepts every reason the wake queue treats as comment-only", () => {
    for (const reason of COMMENT_WAKE_REASONS) {
      expect(
        classifyWakeBatchEligibility(commentWakeContext({ wakeReason: reason })),
      ).toMatchObject({ eligible: true });
    }
  });

  it("accepts a wake that carries a single comment id and no list", () => {
    expect(
      classifyWakeBatchEligibility({
        issueId: "issue-1",
        wakeReason: "issue_commented",
        commentId: "comment-1",
      }),
    ).toEqual({ eligible: true, commentIds: [] });
  });

  it("refuses a wake that carries no comment at all", () => {
    expect(classifyWakeBatchEligibility({ issueId: "issue-1" })).toEqual({
      eligible: false,
      reason: "no_comment_id",
    });
    expect(classifyWakeBatchEligibility(null)).toEqual({
      eligible: false,
      reason: "no_comment_id",
    });
    expect(classifyWakeBatchEligibility("not-a-context")).toEqual({
      eligible: false,
      reason: "no_comment_id",
    });
  });

  it("refuses a comment on a run the operator is watching", () => {
    expect(
      classifyWakeBatchEligibility(
        commentWakeContext({ paperclipHarnessCheckedOut: true }),
      ),
    ).toEqual({ eligible: false, reason: "operator_is_waiting" });
    expect(
      classifyWakeBatchEligibility(
        commentWakeContext({ paperclipExternalChatExecutionBound: true }),
      ),
    ).toEqual({ eligible: false, reason: "operator_is_waiting" });
  });

  it("refuses an interaction wake and an interaction continuation", () => {
    expect(
      classifyWakeBatchEligibility(commentWakeContext({ interactionId: "int-1" })),
    ).toEqual({ eligible: false, reason: "interaction" });
    expect(
      classifyWakeBatchEligibility(commentWakeContext({ interactionKind: "confirm" })),
    ).toEqual({ eligible: false, reason: "interaction" });
    expect(
      classifyWakeBatchEligibility(commentWakeContext({ resumeIntent: true })),
    ).toEqual({ eligible: false, reason: "interaction" });
  });

  it("refuses a wake that is not a comment wake", () => {
    expect(
      classifyWakeBatchEligibility(commentWakeContext({ wakeReason: "issue_assigned" })),
    ).toEqual({ eligible: false, reason: "not_a_comment_wake" });
    expect(
      classifyWakeBatchEligibility(
        commentWakeContext({ wakeReason: "issue_interaction_opened" }),
      ),
    ).toEqual({ eligible: false, reason: "not_a_comment_wake" });
  });
});

describe("wake batch hold", () => {
  it("holds a comment wake until its window closes", () => {
    const decision = decideWakeBatchHold({
      run: queuedRun({ id: "run-1", createdAt: new Date(now.getTime() - 4_000) }),
      now,
      windowMs,
    });
    expect(decision).toEqual({
      hold: true,
      batch: {
        runId: "run-1",
        issueId: "issue-1",
        commentIds: ["comment-1"],
        deadline: new Date(now.getTime() + 6_000),
        remainingMs: 6_000,
      },
    });
  });

  it("lets the run start as soon as the window has closed", () => {
    expect(
      decideWakeBatchHold({
        run: queuedRun({ id: "run-1", createdAt: new Date(now.getTime() - windowMs) }),
        now,
        windowMs,
      }),
    ).toEqual({ hold: false, reason: "window_elapsed" });
    expect(
      decideWakeBatchHold({
        run: queuedRun({ id: "run-1", createdAt: new Date(now.getTime() - 60_000) }),
        now,
        windowMs,
      }),
    ).toEqual({ hold: false, reason: "window_elapsed" });
  });

  it("is disabled by a zero window", () => {
    expect(
      decideWakeBatchHold({
        run: queuedRun({ id: "run-1", createdAt: now }),
        now,
        windowMs: 0,
      }),
    ).toEqual({ hold: false, reason: "disabled" });
  });

  it("carries the reason a run is not held through", () => {
    expect(
      decideWakeBatchHold({
        run: queuedRun({
          id: "run-1",
          createdAt: now,
          contextSnapshot: commentWakeContext({ interactionId: "int-1" }),
        }),
        now,
        windowMs,
      }),
    ).toEqual({ hold: false, reason: "interaction" });
  });
});

describe("wake batch split of a dispatch pass", () => {
  it("keeps the pass order of the runs it leaves startable", () => {
    const runs = [
      queuedRun({ id: "run-elapsed", createdAt: new Date(now.getTime() - 30_000) }),
      queuedRun({
        id: "run-assigned",
        createdAt: now,
        contextSnapshot: { issueId: "issue-2", wakeReason: "issue_assigned" },
      }),
      queuedRun({ id: "run-held", createdAt: new Date(now.getTime() - 1_000) }),
    ];
    const split = splitBatchedWakeRuns(runs, { now, windowMs });
    expect(split.runnable.map((run) => run.id)).toEqual(["run-elapsed", "run-assigned"]);
    // The run objects are handed back untouched, so the caller claims exactly
    // the rows it read.
    expect(split.runnable[0]).toBe(runs[0]);
    expect(split.held.map((hold) => hold.runId)).toEqual(["run-held"]);
    expect(split.resweepDelayMs).toBe(9_000);
  });

  it("asks for one resweep at the earliest deadline of every held run", () => {
    const runs = [
      queuedRun({ id: "run-late", createdAt: new Date(now.getTime() - 1_000) }),
      queuedRun({ id: "run-early", createdAt: new Date(now.getTime() - 8_000) }),
    ];
    const split = splitBatchedWakeRuns(runs, { now, windowMs });
    expect(split.runnable).toEqual([]);
    expect(split.held.map((hold) => hold.runId)).toEqual(["run-late", "run-early"]);
    expect(split.resweepDelayMs).toBe(2_000);
  });

  it("holds nothing when the window is off", () => {
    const runs = [queuedRun({ id: "run-1", createdAt: now })];
    const split = splitBatchedWakeRuns(runs, { now, windowMs: 0 });
    expect(split.runnable).toEqual(runs);
    expect(split.held).toEqual([]);
    expect(split.resweepDelayMs).toBeNull();
  });

  it("holds nothing when there is nothing queued", () => {
    expect(splitBatchedWakeRuns([], { now, windowMs })).toEqual({
      runnable: [],
      held: [],
      resweepDelayMs: null,
    });
  });
});