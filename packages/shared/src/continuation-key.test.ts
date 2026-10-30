import { describe, expect, it } from "vitest";
import {
  buildContinuationKey,
  continuationKeyInputSchema,
  type ContinuationDedupeMetrics,
  type ContinuationDedupeOutcome,
  type ContinuationKeyInput,
} from "./continuation-key.js";

const base: ContinuationKeyInput = {
  issueId: "issue-1",
  event: "issue_continuation_needed",
  head: "comment-9",
};

describe("buildContinuationKey", () => {
  it("is deterministic: the same input gives the same key", () => {
    expect(buildContinuationKey(base)).toBe(buildContinuationKey({ ...base }));
  });

  it("changes the key when the event changes", () => {
    expect(buildContinuationKey({ ...base, event: "issue_assignment_recovery" })).not.toBe(
      buildContinuationKey(base),
    );
  });

  it("changes the key when the head changes", () => {
    expect(buildContinuationKey({ ...base, head: "comment-10" })).not.toBe(
      buildContinuationKey(base),
    );
  });

  it("changes the key when the issue changes", () => {
    expect(buildContinuationKey({ ...base, issueId: "issue-2" })).not.toBe(
      buildContinuationKey(base),
    );
  });

  it("rejects an empty event", () => {
    expect(() => buildContinuationKey({ ...base, event: "" })).toThrow();
    expect(() => buildContinuationKey({ ...base, event: "   " })).toThrow();
  });

  it("rejects an empty head and an empty issueId", () => {
    expect(() => buildContinuationKey({ ...base, head: "" })).toThrow();
    expect(() => buildContinuationKey({ ...base, issueId: " " })).toThrow();
  });

  it("separates fields: no collision across different splits of one tuple", () => {
    const a = buildContinuationKey({ issueId: "a", event: "bc", head: "d" });
    const b = buildContinuationKey({ issueId: "a", event: "b", head: "cd" });
    expect(a).not.toBe(b);
  });

  it("rejects unknown extra fields", () => {
    expect(
      continuationKeyInputSchema.safeParse({ ...base, extra: 1 }).success,
    ).toBe(false);
  });
});

describe("ContinuationDedupeOutcome and ContinuationDedupeMetrics contracts", () => {
  it("carries the key with each outcome", () => {
    const key = buildContinuationKey(base);
    const outcomes: ContinuationDedupeOutcome[] = [
      { outcome: "created", key },
      { outcome: "deduped", key },
    ];
    for (const outcome of outcomes) {
      expect(outcome.key).toBe(key);
    }
  });

  it("reports created and deduped claims", () => {
    const created: string[] = [];
    const deduped: string[] = [];
    const metrics: ContinuationDedupeMetrics = {
      onContinuationCreated: (key) => created.push(key),
      onContinuationDeduped: (key) => deduped.push(key),
    };
    const key = buildContinuationKey(base);
    metrics.onContinuationCreated(key);
    metrics.onContinuationDeduped(key);
    expect(created).toEqual([key]);
    expect(deduped).toEqual([key]);
  });
});
