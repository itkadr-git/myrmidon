import { describe, expect, it, vi } from "vitest";
import { reconcileIssueParentCyclesOnStartup } from "./issue-parent-cycle-reconciliation.js";

describe("reconcileIssueParentCyclesOnStartup", () => {
  it("repairs a cycle longer than the former 1000-edge limit", async () => {
    const longCycle = Array.from({ length: 1002 }, (_, index) => ({
      id: `node-${index}`,
      company_id: "company",
      parent_id: `node-${(index + 1) % 1002}`,
    }));
    const execute = vi.fn().mockResolvedValue(longCycle);
    const logActivity = vi.fn().mockResolvedValue(undefined);
    const db = { execute } as never;
    const activityModule = await import("./activity-log.js");
    vi.spyOn(activityModule, "logActivity").mockImplementation(logActivity);

    const result = await reconcileIssueParentCyclesOnStartup(db);

    expect(result).toEqual({ repaired: 1002 });
    expect(execute).toHaveBeenCalledTimes(1);
    const query = execute.mock.calls[0]?.[0];
    expect(query?.queryChunks?.map((chunk: { value?: string[] }) => chunk.value?.join("") ?? "").join(""))
      .not.toContain("1000");
    expect(logActivity).toHaveBeenCalledTimes(1002);
  });

  it("clears each cyclic parent edge and audits the repair", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([
        { id: "self", company_id: "company", parent_id: "self" },
        { id: "a", company_id: "company", parent_id: "b" },
        { id: "b", company_id: "company", parent_id: "a" },
      ])
      .mockImplementation(async () => [{ id: "repaired" }]);
    const logActivity = vi.fn().mockResolvedValue(undefined);
    const db = { execute } as never;
    const activityModule = await import("./activity-log.js");
    vi.spyOn(activityModule, "logActivity").mockImplementation(logActivity);

    const result = await reconcileIssueParentCyclesOnStartup(db);

    expect(result).toEqual({ repaired: 3 });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(logActivity).toHaveBeenCalledTimes(3);
    expect(logActivity).toHaveBeenCalledWith(db, expect.objectContaining({
      action: "issue.parent_cycle_repaired",
      entityId: "self",
      details: { previousParentId: "self" },
    }));
    expect(logActivity).toHaveBeenCalledWith(db, expect.objectContaining({
      action: "issue.parent_cycle_repaired",
      entityId: "a",
      details: { previousParentId: "b" },
    }));
    expect(logActivity).toHaveBeenCalledWith(db, expect.objectContaining({
      action: "issue.parent_cycle_repaired",
      entityId: "b",
      details: { previousParentId: "a" },
    }));
  });
});