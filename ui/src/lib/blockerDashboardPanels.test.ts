import { describe, expect, it } from "vitest";
import { BLOCKER_DASHBOARD_PANELS, BLOCKER_ROOT_FANOUT_LIMIT } from "./blockerDashboardPanels";

describe("blocker dashboard panels", () => {
  it("defines all four panels and a positive root fan-out threshold", () => {
    expect(BLOCKER_DASHBOARD_PANELS).toHaveLength(4);
    expect(BLOCKER_DASHBOARD_PANELS.map(({ id }) => id)).toEqual(["blocked_age", "root_fanout", "missing_fields", "terminal"]);
    expect(BLOCKER_DASHBOARD_PANELS.every(({ title, query }) => title.length > 0 && query.length > 0)).toBe(true);
    expect(BLOCKER_DASHBOARD_PANELS[1]).toMatchObject({ threshold: BLOCKER_ROOT_FANOUT_LIMIT, unit: "issues" });
    expect(BLOCKER_ROOT_FANOUT_LIMIT).toBeGreaterThan(0);
  });
});
