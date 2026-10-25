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
import { UI2_ROUTE_TABLE, isUi2RouteElementAPlaceholder } from "../routes";
import { UI2_SETTINGS_SECTIONS } from "../shell/Ui2SettingsSidebar";
import { fleetStatus } from "../screens/agent-overview/Ui2AgentsFleetPage";


  it("routes every settings sidebar entry through UI2 or the company settings route tree", () => {
    const appSource = readFileSync(fileURLToPath(new URL("../../App.tsx", import.meta.url)), "utf8");
    const routeBlock = appSource.match(/function boardRoutes\([\s\S]*?(?=\nfunction )/)?.[0];
    expect(routeBlock).toBeDefined();

    const appSettingsPaths = new Set(
      [...routeBlock!.matchAll(/path="(company\/settings(?:\/[^"]*)?)"/g)].map(([, path]) => `/${path}`),
    );
    const ui2Paths = new Set(UI2_ROUTE_TABLE.map((entry) => `/${entry.path}`));
    const routedPaths = new Set([...appSettingsPaths, ...ui2Paths]);
    const sidebarPaths = UI2_SETTINGS_SECTIONS.map(({ path }) => path);

    expect(new Set(sidebarPaths).size).toBe(sidebarPaths.length);
    for (const path of sidebarPaths) {
      expect(routedPaths.has(path), path).toBe(true);
    }
    expect(sidebarPaths).not.toContain("/company/settings/guards");
    expect(routedPaths.has("/company/settings/guards")).toBe(false);
    expect(routedPaths.has("/company/settings/not-a-real-page")).toBe(false);
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
      "settings-autonomy-regulations",
      "settings-language",
      "settings-runs-queue",
      "settings-system",
    ]);
  });

  it("marks the knowledge and regulations nav items as gated on the knowledge API", () => {
    const items = UI2_NAV_GROUPS.flatMap((group) => group.items);
    for (const to of ["/knowledge", "/company/settings/autonomy/regulations"]) {
      expect(items.find((item) => item.to === to)?.requires).toBe("knowledge");
    }
  });

  it("renders plugin nav groups in both rail and phone nav when slots or launchers exist", () => {
    const rail = readFileSync(fileURLToPath(new URL("../shell/Ui2Rail.tsx", import.meta.url)), "utf8");
    const phone = readFileSync(fileURLToPath(new URL("../shell/Ui2PhoneNav.tsx", import.meta.url)), "utf8");
    for (const source of [rail, phone]) {
      expect(source).toMatch(/hasPlugins\s*=\s*pluginSlots\.length\s*>\s*0/);
      expect(source).toContain("PluginSlotMount");
      expect(source).toContain("PluginLauncherOutlet");
      expect(source).not.toContain('className="hidden"');
    }
    expect(rail).toContain('t("ui2.nav.group.plugins"');
    expect(phone).toContain('aria-label={t("ui2.nav.group.plugins"');
    expect(phone).toContain("myr-ui2__phone-navigation");
    expect(readFileSync(fileURLToPath(new URL("../i18n/locales.ts", import.meta.url)), "utf8")).toContain('"ui2.nav.group.plugins": "Плагины"');
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
