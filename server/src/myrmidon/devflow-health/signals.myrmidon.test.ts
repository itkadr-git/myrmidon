import { describe, expect, it } from "vitest";
import { buildDevflowSignals, redCiSince } from "./signals.js";

const now = new Date("2026-10-27T20:00:00Z");
describe("DEVFLOW runtime signals", () => {
  it("delivers a company-scoped deterministic alert only at the threshold", () => {
    const sample = { companyId: "company-a", subjectId: "issue-a", subjectKind: "issue" as const,
      title: "Review", metric: "reviewQueueAgeMs" as const, since: "2026-10-27T19:59:00Z" };
    expect(buildDevflowSignals([sample], { reviewQueueAgeMs: 60_001 }, now)).toEqual([]);
    expect(buildDevflowSignals([sample], { reviewQueueAgeMs: 60_000 }, now)).toMatchObject([
      { companyId: "company-a", subjectId: "issue-a", durationMs: 60_000, dedupKey: "devflow:company-a:reviewQueueAgeMs:issue-a" },
    ]);
  });
  it("preserves the first failure until a successful completion, ignoring reruns in progress", () => {
    expect(redCiSince([
      { conclusion: "failure", at: "2026-10-27T18:00:00Z" },
      { conclusion: "failure", at: "2026-10-27T19:00:00Z" },
      { conclusion: null, at: "2026-10-27T19:30:00Z" },
    ])).toBe("2026-10-27T18:00:00Z");
    expect(redCiSince([
      { conclusion: "success", at: "2026-10-27T19:00:00Z" },
      { conclusion: "failure", at: "2026-10-27T18:00:00Z" },
    ])).toBeNull();
  });
  it("does not turn cancelled/skipped/invalid events into red CI", () => {
    expect(redCiSince([{ conclusion: "cancelled", at: now.toISOString() },
      { conclusion: "failure", at: "invalid" }])).toBeNull();
  });
});
