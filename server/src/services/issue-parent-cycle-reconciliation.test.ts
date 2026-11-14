import { describe, expect, it, vi } from "vitest";
import { reconcileIssueParentCyclesOnStartup } from "./issue-parent-cycle-reconciliation.js";

describe("reconcileIssueParentCyclesOnStartup", () => {
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
    }));
  });
});