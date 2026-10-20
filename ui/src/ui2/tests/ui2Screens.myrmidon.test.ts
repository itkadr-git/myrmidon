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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { UI2_NAV_GROUPS, UI2_PHONE_TABS } from "../navModel";
import { UI2_ROUTE_TABLE } from "../routes";
import { isUi2RouteElementAPlaceholder } from "../routes";
import { fleetStatus } from "../screens/agent-overview/Ui2AgentsFleetPage";

const fleetScreenSource = readFileSync(
  fileURLToPath(new URL("../screens/agent-overview/Ui2AgentsFleetPage.tsx", import.meta.url)),
  "utf8",
);

describe("myrmidon(UI2) route table integration", () => {
  it("ships exactly the six contract entries plus the commander chat", () => {
    expect(UI2_ROUTE_TABLE.map((entry) => entry.key).sort()).toEqual([
      "agent-overview",
      "agents-fleet",
      "commander-chat",
      "costs",
      "decisions",
      "settings-language",
      "settings-runs-queue",
      "settings-system",
    ]);
  });

  it("keeps the fleet route reachable from both desktop and phone navigation", () => {
    expect(UI2_NAV_GROUPS.flatMap((group) => group.items).filter((item) => item.to === "/agents")).toHaveLength(1);
    expect(UI2_PHONE_TABS.filter((item) => item.to === "/agents")).toHaveLength(1);
    expect(UI2_PHONE_TABS.some((item) => item.to === "/more")).toBe(true);
  });

  it("uses company-scoped agents and bounded live-run data", () => {
    expect(fleetScreenSource).toContain("agentsApi.list(companyId)");
    expect(fleetScreenSource).toContain('liveRunsForCompany(companyId, { minCount: 50, limit: 100 })');
    expect(fleetScreenSource).toContain('status === "paused"');
    expect(fleetScreenSource).toContain("agent.reportsTo");
    expect(fleetScreenSource).toContain("overflow-y-auto");
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
    expect(byKey.get("agents-fleet")?.path).toBe("agents");
    expect(byKey.get("settings-runs-queue")?.path).toBe("company/settings/runs-queue");
    expect(byKey.get("settings-system")?.path).toBe("company/settings/system");
    expect(byKey.get("settings-language")?.path).toBe("company/settings/language");
    expect(byKey.get("decisions")?.legacyPath).toBe("/decisions");
    expect(byKey.get("costs")?.legacyPath).toBe("/activity/costs");
    expect(byKey.get("agent-overview")?.legacyPath).toBe("/agents/:agentId");
    expect(byKey.get("agents-fleet")?.legacyPath).toBe("/agents");
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
