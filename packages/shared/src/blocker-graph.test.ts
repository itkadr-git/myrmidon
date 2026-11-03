import { describe, expect, it } from "vitest";
import {
  BLOCKER_DASHBOARD_PANELS,
  BLOCKER_ROOT_FANOUT_LIMIT,
  blockerGraphRootsResponseSchema,
} from "./blocker-graph.js";

describe("BLOCKER_DASHBOARD_PANELS", () => {
  it("defines all four panels and a positive root fan-out threshold", () => {
    expect(BLOCKER_DASHBOARD_PANELS).toHaveLength(4);
    expect(BLOCKER_DASHBOARD_PANELS.map(({ id }) => id)).toEqual([
      "blocked_age",
      "root_fanout",
      "missing_fields",
      "terminal",
    ]);
    expect(BLOCKER_DASHBOARD_PANELS.every(({ title, query }) => title.length > 0 && query.length > 0)).toBe(true);
    expect(BLOCKER_DASHBOARD_PANELS[1]).toMatchObject({ threshold: BLOCKER_ROOT_FANOUT_LIMIT, unit: "issues" });
    expect(BLOCKER_ROOT_FANOUT_LIMIT).toBeGreaterThan(0);
  });
});

describe("blockerGraphRootsResponseSchema", () => {
  const validResponse = {
    roots: [{
      rootIssueId: "issue-1",
      rootIdentifier: "OPE-1",
      rootStatus: "blocked",
      dependentCount: 1,
      dependents: ["issue-2"],
      oldestBlockedAt: "2026-10-25T00:00:00.000Z",
      hasMissingFields: false,
    }],
    limit: 100,
    generatedAt: "2026-10-25T00:00:00.000Z",
  };

  it("accepts a valid response", () => {
    expect(blockerGraphRootsResponseSchema.safeParse(validResponse).success).toBe(true);
  });

  it("rejects a negative dependent count", () => {
    expect(blockerGraphRootsResponseSchema.safeParse({
      ...validResponse,
      roots: [{ ...validResponse.roots[0], dependentCount: -1 }],
    }).success).toBe(false);
  });

  it("requires rootIssueId", () => {
    const { rootIssueId: _removed, ...root } = validResponse.roots[0];
    expect(blockerGraphRootsResponseSchema.safeParse({
      ...validResponse,
      roots: [root],
    }).success).toBe(false);
  });
});
