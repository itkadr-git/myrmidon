import { describe, expect, it } from "vitest";
import { blockerGraphRootsResponseSchema } from "./blocker-graph.js";

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
