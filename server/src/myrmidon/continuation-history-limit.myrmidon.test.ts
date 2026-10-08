import { describe, expect, it } from "vitest";
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";
import {
  DEFAULT_CONTINUATION_HISTORY_LIMIT,
  limitExecutionContinuationHistory,
  readContinuationHistoryLimit,
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

// myrmidon(DB-CARE DBC-3): the entry cap alone does not bound the payload.
describe("continuation message character budget (DB-CARE DBC-3)", () => {
  const body = (chars: number) => "x".repeat(chars);
  const storedChars = (messages: Message[]) =>
    messages.reduce((total, entry) => total + JSON.stringify(entry).length, 0);

  it("turns the oldest bodies into references to fit the budget", () => {
    const messages = Array.from({ length: 6 }, (_, i) => message(`m${i}`, { body: body(1_000) }));
    const result = limitExecutionContinuationHistory(envelope({ messages }), 10, 4_000, 8_000);

    expect(result.historyCharTruncation?.beforeChars).toBeGreaterThan(4_000);
    expect(storedChars(result.messages)).toBeLessThanOrEqual(4_000);
    const references = result.messages.filter((entry) => entry.bodyOmitted === true);
    expect(references.length).toBeGreaterThan(0);
    expect(references.every((entry) => entry.body === "")).toBe(true);
    expect(result.historyCharTruncation?.bodiesReplaced).toBe(references.length);
    expect(result.messages.at(-1)?.bodyOmitted).toBeUndefined();
    // The reference keeps identity and freshness, so the delta still recognizes it.
    expect(references[0]?.id).toBe(messages[0]?.id);
    expect(references[0]?.updatedAt).toBe(messages[0]?.updatedAt);
    expect(result.truncationNotice).toContain("character continuation budget");
  });

  it("keeps the bodies that carry direction and drops only referenced messages", () => {
    const messages = Array.from({ length: 5 }, (_, i) => message(`m${i}`, { body: body(1_000) }));
    messages[0] = message("m0", { authorType: "user", authorId: "user-a", body: body(1_000) });
    const result = limitExecutionContinuationHistory(envelope({ messages }), 10, 1_500, 8_000);

    const pinned = result.messages.find((entry) => entry.id === "m0");
    expect(pinned).toBeDefined();
    expect(pinned?.bodyOmitted).toBeUndefined();
    expect(pinned?.body).toBe(body(1_000));
    expect(result.historyCharTruncation?.messagesDropped).toBeGreaterThan(0);
    expect(ids(result.messages)).not.toContain("m1");
  });

  it("shortens a pinned body instead of dropping the direction", () => {
    const messages = [message("m0", { authorType: "user", authorId: "user-a", body: body(1_000) })];
    const result = limitExecutionContinuationHistory(envelope({ messages }), 10, 300, 120);

    const pinned = result.messages.find((entry) => entry.id === "m0");
    expect(pinned).toBeDefined();
    expect(pinned?.bodyOmitted).toBeUndefined();
    expect(pinned?.body).toContain("continuation cap:");
    expect(result.historyCharTruncation?.bodiesTruncated).toBe(1);
  });

  it("caps the resume delta bodies the same way, deterministically", () => {
    const messages = Array.from({ length: 4 }, (_, i) => message(`m${i}`, { body: body(1_000) }));
    const input = envelope({ messages, resumeDelta: { baseRunId: "run-a", messages } });
    const first = limitExecutionContinuationHistory(input, 10, 2_500, 8_000);
    const second = limitExecutionContinuationHistory(input, 10, 2_500, 8_000);

    expect(first.resumeDelta?.messages).toEqual(second.resumeDelta?.messages);
    expect(storedChars(first.messages)).toBeLessThanOrEqual(2_500);
    expect(
      (first.resumeDelta?.messages ?? []).some((entry) => entry.bodyOmitted === true),
    ).toBe(true);
  });

  it("keeps the bodies untouched when the character budget is disabled", () => {
    const messages = Array.from({ length: 6 }, (_, i) => message(`m${i}`, { body: body(2_000) }));
    const input = envelope({ messages });

    // 0 disables the character budget: no body becomes a reference, and with
    // the entry cap out of reach as well the envelope comes back unchanged.
    const budgetOff = limitExecutionContinuationHistory(input, 10, 0, 120);
    expect(budgetOff).toBe(input);
    expect(budgetOff.historyCharTruncation).toBeUndefined();

    // The entry cap keeps running on its own and still leaves every body alone.
    const entryCapped = limitExecutionContinuationHistory(
      envelope({
        messages: Array.from({ length: 50 }, (_, i) => message(`m${i}`, { body: body(2_000) })),
      }),
      30,
      0,
      120,
    );
    expect(entryCapped.messages).toHaveLength(30);
    expect(
      entryCapped.messages.every(
        (entry) => entry.bodyOmitted !== true && entry.body.length === 2_000,
      ),
    ).toBe(true);
    expect(entryCapped.historyCharTruncation).toBeUndefined();
    expect(entryCapped.historyTruncation?.messages?.kept).toBe(30);
  });
});
