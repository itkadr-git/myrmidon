import { describe, expect, it } from "vitest";
import { computeRootFanout } from "./root-fanout.js";

describe("computeRootFanout", () => {
  it("counts twenty blocked issues against one terminal root", () => {
    const result = computeRootFanout(Array.from({ length: 20 }, (_, index) => ({
      blockedId: `dependent-${index}`,
      blockerId: "root",
      blockerStatus: "blocked",
    })));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ rootIssueId: "root", dependentCount: 20 });
  });

  it("follows a blocker chain to its terminal root", () => {
    const result = computeRootFanout([
      { blockedId: "A", blockerId: "B", blockerStatus: "blocked" },
      { blockedId: "B", blockerId: "C", blockerStatus: "todo" },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ rootIssueId: "C", dependentCount: 2 });
  });

  it("marks cycles without recursing forever", () => {
    const result = computeRootFanout([
      { blockedId: "A", blockerId: "B", blockerStatus: "blocked" },
      { blockedId: "B", blockerId: "A", blockerStatus: "blocked" },
    ]);

    expect(result.map(({ rootIssueId }) => rootIssueId)).toEqual(["A", "B"]);
    expect(result.every(({ dependentCount }) => dependentCount === 0)).toBe(true);
  });

  it("ignores resolved blockers", () => {
    expect(computeRootFanout([
      { blockedId: "A", blockerId: "done-root", blockerStatus: "done" },
      { blockedId: "B", blockerId: "cancelled-root", blockerStatus: "cancelled" },
    ])).toEqual([]);
  });
});
