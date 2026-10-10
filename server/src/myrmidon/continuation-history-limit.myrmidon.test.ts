import { describe, expect, it } from "vitest";
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";
import {
  DEFAULT_CONTINUATION_HISTORY_CHARS,
  DEFAULT_CONTINUATION_HISTORY_LIMIT,
  DEFAULT_CONTINUATION_MESSAGE_MAX_CHARS,
  limitExecutionContinuationHistory,
  readContinuationHistoryChars,
  readContinuationHistoryLimit,
  readContinuationMessageMaxChars,
} from "./continuation-history-limit.js";

type Message = ExecutionContinuationEnvelope["messages"][number];

function message(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    authorType: "agent",
    authorId: "agent-a",
    createdByRunId: null,
    body: `note ${id}`,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    deleted: false,
    sourceTrust: null,
    ...overrides,
  };
}

function envelope(overrides: Partial<ExecutionContinuationEnvelope> = {}): ExecutionContinuationEnvelope {
  return {
    version: 1,
    companyId: "company-a",
    issueId: "issue-a",
    trigger: { reason: "issue_commented", interactionId: null, sourceRunId: null },
    originCommentIds: [],
    objective: "objective",
    messages: [],
    interactionOutcomes: [],
    completedWork: null,
    unresolvedInteractionIds: [],
    coverage: { kind: "full_task_history", throughCommentId: null, summaryThroughCommentId: null },
    ...overrides,
  };
}

const ids = (list: Array<{ id: string }>) => list.map((entry) => entry.id);

describe("readContinuationHistoryLimit", () => {
  it("defaults to 30", () => {
    expect(DEFAULT_CONTINUATION_HISTORY_LIMIT).toBe(30);
    expect(readContinuationHistoryLimit({})).toBe(30);
  });

  it("reads a non-negative integer and falls back on invalid values", () => {
    expect(readContinuationHistoryLimit({ MYRMIDON_CONTINUATION_HISTORY_LIMIT: "0" })).toBe(0);
    expect(readContinuationHistoryLimit({ MYRMIDON_CONTINUATION_HISTORY_LIMIT: " 12 " })).toBe(12);
    expect(readContinuationHistoryLimit({ MYRMIDON_CONTINUATION_HISTORY_LIMIT: "-5" })).toBe(30);
    expect(readContinuationHistoryLimit({ MYRMIDON_CONTINUATION_HISTORY_LIMIT: "ten" })).toBe(30);
    expect(readContinuationHistoryLimit({ MYRMIDON_CONTINUATION_HISTORY_LIMIT: "" })).toBe(30);
  });
});

describe("limitExecutionContinuationHistory", () => {
  it("leaves a short history untouched", () => {
    const input = envelope({ messages: [message("m1"), message("m2")] });
    expect(limitExecutionContinuationHistory(input, 5)).toBe(input);
  });

  it("keeps pinned requests and origin comments plus the newest messages", () => {
    const messages = Array.from({ length: 20 }, (_, i) => message(`m${i}`));
    messages[0] = message("m0", { authorType: "user", authorId: "user-a", body: "first request" });
    messages[7] = message("m7", { authorType: "user", authorId: "user-a", body: "latest request" });
    // A run-authored user comment is not direction and does not count as the latest request.
    messages[15] = message("m15", { authorType: "user", authorId: "user-a", createdByRunId: "run-a" });
    const result = limitExecutionContinuationHistory(envelope({ messages, originCommentIds: ["m3"] }), 6);

    expect(ids(result.messages)).toEqual(["m0", "m3", "m7", "m17", "m18", "m19"]);
    expect(result.historyTruncation?.messages).toEqual({ kept: 6, dropped: 14, total: 20 });
    expect(result.truncationNotice).toContain("messages 14 of 20");
  });

  it("limits the other unbounded lists to their newest entries", () => {
    const list = Array.from({ length: 8 }, (_, i) => i);
    const result = limitExecutionContinuationHistory(
      envelope({
        interactionOutcomes: list.map((i) => ({ id: `i${i}`, kind: "k", status: "accepted", result: null })),
        completedActions: list.map((i) => ({ runId: "r", receiptId: `c${i}`, operationId: "op", result: null })),
        recoveryOutcomes: list.map((i) => ({ recoveryActionId: `a${i}`, decision: null })),
        unresolvedInteractionIds: list.map((i) => `u${i}`),
      }),
      3,
    );
    expect(ids(result.interactionOutcomes)).toEqual(["i5", "i6", "i7"]);
    expect(result.completedActions?.map((entry) => entry.receiptId)).toEqual(["c5", "c6", "c7"]);
    expect(result.recoveryOutcomes?.map((entry) => entry.recoveryActionId)).toEqual(["a5", "a6", "a7"]);
    expect(result.unresolvedInteractionIds).toEqual(["u5", "u6", "u7"]);
    expect(Object.keys(result.historyTruncation ?? {}).sort()).toEqual([
      "completedActions",
      "interactionOutcomes",
      "recoveryOutcomes",
      "unresolvedInteractionIds",
    ]);
  });

  it("limits the resume delta with the same pins", () => {
    const messages = Array.from({ length: 10 }, (_, i) => message(`m${i}`));
    messages[1] = message("m1", { authorType: "user", authorId: "user-a", body: "request" });
    const result = limitExecutionContinuationHistory(
      envelope({ messages, resumeDelta: { baseRunId: "run-a", messages: messages.slice(1) } }),
      3,
    );
    expect(result.resumeDelta?.baseRunId).toBe("run-a");
    expect(ids(result.resumeDelta?.messages ?? [])).toEqual(["m1", "m8", "m9"]);
    expect(result.historyTruncation?.resumeDeltaMessages).toEqual({ kept: 3, dropped: 6, total: 9 });
  });

  it("does nothing when the limit is 0", () => {
    const input = envelope({ messages: Array.from({ length: 50 }, (_, i) => message(`m${i}`)) });
    expect(limitExecutionContinuationHistory(input, 0)).toBe(input);
  });
});

describe("readContinuationHistoryChars and readContinuationMessageMaxChars (1.6.6 LONG-TASK-CONTEXT)", () => {
  it("defaults to the shared long-task budget of 24k and a 8k per-entry cap", () => {
    expect(DEFAULT_CONTINUATION_HISTORY_CHARS).toBe(24_000);
    expect(DEFAULT_CONTINUATION_MESSAGE_MAX_CHARS).toBe(8_000);
    expect(readContinuationHistoryChars({})).toBe(24_000);
    expect(readContinuationMessageMaxChars({})).toBe(8_000);
  });

  it("reads a non-negative integer and falls back on invalid values", () => {
    expect(readContinuationHistoryChars({ MYRMIDON_CONTINUATION_HISTORY_CHARS: "0" })).toBe(0);
    expect(readContinuationHistoryChars({ MYRMIDON_CONTINUATION_HISTORY_CHARS: " 5000 " })).toBe(5_000);
    expect(readContinuationHistoryChars({ MYRMIDON_CONTINUATION_HISTORY_CHARS: "-1" })).toBe(24_000);
    expect(readContinuationHistoryChars({ MYRMIDON_CONTINUATION_HISTORY_CHARS: "lots" })).toBe(24_000);
    expect(readContinuationMessageMaxChars({ MYRMIDON_CONTINUATION_MESSAGE_MAX_CHARS: "0" })).toBe(0);
    expect(readContinuationMessageMaxChars({ MYRMIDON_CONTINUATION_MESSAGE_MAX_CHARS: "1200" })).toBe(1_200);
  });
});

describe("volume bound of an ever-running task (1.6.6 LONG-TASK-CONTEXT)", () => {
  const body = (id: string, size: number) => `${id}|` + "x".repeat(size);
  const long = (id: string, size: number, overrides: Partial<Message> = {}) =>
    message(id, { body: body(id, size), ...overrides });
  const volume = (list: Array<{ body: string }>) =>
    list.reduce((total, entry) => total + entry.body.length, 0);

  it("keeps the newest entries that fit the character budget and references the rest", () => {
    const messages = Array.from({ length: 40 }, (_, i) => long(`m${i}`, 1_000));
    const result = limitExecutionContinuationHistory(envelope({ messages }), 40, 10_000, 0);

    // Every body carries its id plus a 1000-character payload (1004 characters
    // for a three-character id), so nine newest fit the 10k budget exactly and
    // the tenth would break it.
    expect(result.messages.length).toBe(9);
    expect(ids(result.messages)).toEqual(
      Array.from({ length: 9 }, (_, i) => `m${31 + i}`),
    );
    expect(volume(result.messages)).toBeLessThanOrEqual(10_000);
    expect(result.historyTruncation?.messages).toEqual({ kept: 9, dropped: 31, total: 40 });
    expect(result.truncationNotice).toContain("10000 characters of message text");
    expect(result.truncationNotice).toContain("messages 31 of 40");
    expect(result.truncationNotice).toContain("GET /api/issues/issue-a/comments");
  });

  it("always keeps the pinned direction, even when it is what blows the budget", () => {
    const messages = Array.from({ length: 30 }, (_, i) => long(`m${i}`, 500));
    messages[0] = long("m0", 30_000, { authorType: "user", authorId: "user-a" });
    const result = limitExecutionContinuationHistory(envelope({ messages }), 30, 5_000, 0);

    expect(ids(result.messages)).toContain("m0");
    expect(ids(result.messages)).toContain("m29");
    expect(result.messages.length).toBeLessThan(30);
    expect(result.historyTruncation?.messages?.total).toBe(30);
  });

  it("caps a single oversized entry and names where its full text stays", () => {
    const oversized = long("big", 50_000);
    const omitted = oversized.body.length - 8_000;
    const result = limitExecutionContinuationHistory(
      envelope({ messages: [message("m0"), oversized] }),
      30,
      0,
      8_000,
    );
    const capped = result.messages.find((entry: Message) => entry.id === "big");
    expect(capped?.body).toContain(`${omitted} characters of this entry were omitted`);
    expect(capped?.body).toContain("GET /api/issues/issue-a/comments");
    expect(capped?.body.length).toBeLessThan(8_500);
    expect(result.messages.find((entry: Message) => entry.id === "m0")?.body).toBe("note m0");
    expect(result.historyTruncation?.messageBodies).toEqual({ kept: 2, dropped: 1, total: 2 });
  });

  it("bounds a synthetic 165-comment task thread instead of shipping it every run", () => {
    const messages = Array.from({ length: 165 }, (_, i) =>
      i === 0
        ? long("c0", 20, { authorType: "user", authorId: "user-a" })
        : long(`c${i}`, 1_500),
    );
    const result = limitExecutionContinuationHistory(
      envelope({ messages, originCommentIds: ["c120"] }),
      30,
      24_000,
      8_000,
    );

    // The count limit alone would have kept 32 entries; the volume bound cuts
    // the payload to roughly the budget plus the pinned direction.
    expect(result.messages.length).toBeLessThan(30);
    expect(ids(result.messages)).toContain("c0");
    expect(ids(result.messages)).toContain("c120");
    expect(ids(result.messages)).toContain("c164");
    expect(volume(result.messages)).toBeLessThanOrEqual(24_000 + 2_000);
    expect(result.historyTruncation?.messages?.total).toBe(165);
    expect(result.truncationNotice).toContain("GET /api/issues/issue-a/comments");
  });

  it("leaves a task thread that fits the budget untouched", () => {
    const input = envelope({ messages: Array.from({ length: 12 }, (_, i) => long(`m${i}`, 100)) });
    expect(limitExecutionContinuationHistory(input, 30, 24_000, 8_000)).toBe(input);
  });
});
