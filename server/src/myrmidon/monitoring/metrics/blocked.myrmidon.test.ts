import { describe, expect, it } from "vitest";
import { collectBlockedMetrics, computeBlockedMetrics, renderBlockedMetrics, type BlockedMetricsIssue } from "./blocked.js";

const now = new Date("2026-10-27T08:00:00Z");
const complete = {
  blockReason: "dependency" as const,
  owner: { agentId: "agent-a" },
  nextCheckAt: "2026-10-28T08:00:00Z",
};
const row = (id: string, age: number, blockerMetadata: BlockedMetricsIssue["blockerMetadata"]): BlockedMetricsIssue => ({
  id, status: "blocked", blockerMetadata, blockedSince: new Date(now.getTime() - age * 1000),
});

export const blockedMetricsFixture = [
  row("complete-1", 10, complete),
  row("complete-2", 20, complete),
  row("complete-3", 30, complete),
  row("partial-1", 40, { blockReason: "recovery" }),
  row("partial-2", 50, { owner: { userId: "owner-a" } }),
  row("legacy", 1000, null),
];

describe("blocked metrics", () => {
  it("separates three complete and two incomplete rows from legacy", async () => {
    const calls: string[] = [];
    const groups = await collectBlockedMetrics(async (companyId) => {
      calls.push(companyId);
      return { blockedIssues: blockedMetricsFixture };
    }, "company-a", now);
    expect(calls).toEqual(["company-a"]);
    expect(groups).toEqual([
      { legacy: false, count: 5, ageSeconds: { p50: 30, p95: 50, max: 50 }, missingFields: { reason: 1, owner: 1, nextCheckAt: 2 } },
      { legacy: true, count: 1, ageSeconds: { p50: 1000, p95: 1000, max: 1000 }, missingFields: { reason: 1, owner: 1, nextCheckAt: 1 } },
    ]);
    const text = renderBlockedMetrics(groups);
    expect(text).toContain('blocked_age_seconds{legacy="false",statistic="p50"} 30\n');
    expect(text).toContain('blocked_age_seconds{legacy="true",statistic="max"} 1000\n');
    expect(text).toContain('blocked_missing_fields_total{legacy="false",field="nextCheckAt"} 2\n');
    expect(text.match(/# TYPE blocked_missing_fields_total gauge/g)).toHaveLength(1);
  });

  it("ignores non-blocked rows, excludes unknown dates and clamps future transitions", () => {
    const groups = computeBlockedMetrics([
      { ...row("done", 999, complete), status: "done" },
      { ...row("unknown", 999, complete), blockedSince: null },
      row("future", -10, complete),
    ], now);
    expect(groups[0]).toMatchObject({ count: 2, ageSeconds: { p50: 0, p95: 0, max: 0 } });
    expect(groups[1]).toMatchObject({ count: 0, ageSeconds: { p50: null, p95: null, max: null } });
    expect(renderBlockedMetrics(groups)).not.toContain('blocked_age_seconds{legacy="true"');
  });

  it("treats blank historical fields as missing without classifying partial metadata as legacy", () => {
    expect(computeBlockedMetrics([row("blank", 10, {
      owner: { agentId: " " }, nextCheckAt: " ",
    })], now)[0]?.missingFields).toEqual({ reason: 1, owner: 1, nextCheckAt: 1 });
  });
});
