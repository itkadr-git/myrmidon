// ui/src/ui2/tests/ui2Screens.myrmidom.test.ts — UI-2.0
//
// myrmidon(UI2): the route-table guard for the re-skin integration. The
// shell part owns UI2_ROUTE_TABLE (the integration contract: the six
// flagged screens as entries); this pass replaced the placeholder element
// of every entry with a real screen. The guard pins exactly that: each of
// the six entries carries a NON-placeholder element, the paths stay the
// contract paths (the vendor routes keep their own shapes), and the legacy
// paths stay stable so parity comparison stays possible.

import { describe, expect, it } from "vitest";
import { isUi2PhoneTabActive } from "../shell/Ui2PhoneNav";
import { UI2_NAV_GROUPS, UI2_PHONE_TABS } from "../navModel";
import { UI2_ROUTE_TABLE } from "../routes";
import { isUi2RouteElementAPlaceholder } from "../routes";
import { fleetStatus } from "../screens/agent-overview/Ui2AgentsFleetPage";
import { getReturnFreeReviewRate } from "../screens/quality/Ui2QualityScreen";

describe("myrmidon(UI2) route table integration", () => {
  it("does not label task returns or run counts as run success", () => {
    expect(getReturnFreeReviewRate({ returnRate: { enteredReview: 0, returned: 0 } })).toBeNull();
    expect(getReturnFreeReviewRate({ returnRate: { enteredReview: 10, returned: 2 } })).toBe(80);
    expect(getReturnFreeReviewRate({ returnRate: { enteredReview: 10, returned: 10 } })).toBe(0);
  });

  it("ships exactly the contract entries, the fleet, the commander chat and the knowledge screens", () => {
    expect(UI2_ROUTE_TABLE.map((entry) => entry.key).sort()).toEqual([
      "agent-overview",
      "agents-fleet",
      "commander-chat",
      "costs",
      "decisions",
      "fleet",
      "knowledge",
      "knowledge-page",
      "quality",
      "settings-autonomy-regulations",
      "settings-language",
      "settings-runs-queue",
      "settings-system",
      "system",
    ]);
  });

  it("keeps the system and quality routes and navigation singular", () => {
    const byKey = new Map(UI2_ROUTE_TABLE.map((entry) => [entry.key, entry]));
    expect(byKey.get("system")?.path).toBe("system");
    expect(byKey.get("quality")?.path).toBe("quality");
    for (const [path, key] of [["/system", "system"], ["/quality", "quality"]] as const) {
      const route = byKey.get(key)!;
      expect(route.path).toBe(path.slice(1));
      expect(route.element).toBeTruthy();
      expect(UI2_NAV_GROUPS.flatMap((group) => group.items).filter((item) => item.to === path)).toHaveLength(1);
      // System and quality are reachable from the phone More drawer, not fixed tabs.
      if (key === "system" || key === "quality") {
        expect(UI2_PHONE_TABS.filter((item) => item.to === path)).toHaveLength(0);
        expect(UI2_NAV_GROUPS.flatMap((group) => group.items).some((item) => item.to === path)).toBe(true);
      } else {
        expect(UI2_PHONE_TABS.filter((item) => item.to === path)).toHaveLength(1);
      }
    }
  });

  it("marks the knowledge and regulations nav items as gated on the knowledge API", () => {
    const items = UI2_NAV_GROUPS.flatMap((group) => group.items);
    for (const to of ["/knowledge", "/company/settings/autonomy/regulations"]) {
      expect(items.find((item) => item.to === to)?.requires).toBe("knowledge");
    }
  });

  it("keeps the agents and servers routes reachable from both desktop and phone navigation", () => {
    expect(UI2_NAV_GROUPS.flatMap((group) => group.items).filter((item) => item.to === "/agents")).toHaveLength(1);
    expect(UI2_PHONE_TABS.filter((item) => item.to === "/agents")).toHaveLength(1);
    expect(UI2_NAV_GROUPS.flatMap((group) => group.items).filter((item) => item.to === "/fleet")).toHaveLength(1);
    expect(UI2_PHONE_TABS.filter((item) => item.to === "/fleet")).toHaveLength(1);
    expect(UI2_PHONE_TABS.some((item) => item.to === "/agents/all")).toBe(true);
  });


  it("every entry renders a real screen, not the placeholder", () => {
    for (const entry of UI2_ROUTE_TABLE) {
      expect(isUi2RouteElementAPlaceholder(entry.element), entry.key).toBe(false);
    }
  });

  it("keeps the contract paths and legacy paths stable", () => {
    const byKey = new Map(UI2_ROUTE_TABLE.map((entry) => [entry.key, entry]));
    expect(byKey.get("decisions")?.path).toBe("decisions");
    expect(byKey.get("costs")?.path).toBe("activity/costs");
    expect(byKey.get("agent-overview")?.path).toBe("agents/:agentId/overview");
    expect(byKey.get("fleet")?.path).toBe("fleet");
    expect(byKey.get("agents-fleet")?.path).toBe("agents");
    expect(byKey.get("settings-runs-queue")?.path).toBe("company/settings/runs-queue");
    expect(byKey.get("settings-system")?.path).toBe("company/settings/system");
    expect(byKey.get("settings-language")?.path).toBe("company/settings/language");
    expect(byKey.get("decisions")?.legacyPath).toBe("/decisions");
    expect(byKey.get("costs")?.legacyPath).toBe("/activity/costs");
    expect(byKey.get("agent-overview")?.legacyPath).toBe("/agents/:agentId");
    expect(byKey.get("agents-fleet")?.legacyPath).toBe("/agents");
  });

  it("activates exactly one tab at /agents in the six-tab phone grid", () => {
    expect(UI2_PHONE_TABS).toHaveLength(6);
    const active = UI2_PHONE_TABS.filter((tab) => isUi2PhoneTabActive(tab.to, "/agents"));
    expect(active.map((tab) => tab.labelKey)).toEqual(["ui2.nav.agents"]);
  });

  it("activates only More at /agents/all in the six-tab phone grid", () => {
    expect(UI2_PHONE_TABS).toHaveLength(6);
    const active = UI2_PHONE_TABS.filter((tab) => isUi2PhoneTabActive(tab.to, "/agents/all"));
    expect(active.map((tab) => tab.labelKey)).toEqual(["ui2.nav.more"]);
  });

  it("maps canonical agent API statuses without treating active as running", () => {
    expect(fleetStatus("active")).toBe("idle");
    expect(fleetStatus("idle")).toBe("idle");
    expect(fleetStatus("running")).toBe("running");
    expect(fleetStatus("paused")).toBe("paused");
    expect(fleetStatus("error")).toBe("error");
    expect(fleetStatus("active", { status: "failed" } as never)).toBe("error");
  });
});
