// ui/src/ui2/tests/ui2Screens.myrmidom.test.ts — UI-2.0
//
// myrmidon(UI2): the route-table guard for the re-skin integration. The
// shell part owns UI2_ROUTE_TABLE (the integration contract: the six
// flagged screens as entries); this pass replaced the placeholder element
// of every entry with a real screen. The guard pins exactly that: each of
// the six entries carries a NON-placeholder element, the paths stay the
// contract paths (the vendor routes keep their own shapes), and the legacy
// paths stay stable so parity comparison stays possible.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isUi2PhoneTabActive } from "../shell/Ui2PhoneNav";
import { UI2_NAV_GROUPS, UI2_PHONE_TABS } from "../navModel";
import { UI2_ROUTE_TABLE, isUi2RouteElementAPlaceholder } from "../routes";
import { UI2_SETTINGS_SECTIONS } from "../shell/Ui2SettingsSidebar";
import { fleetStatus } from "../screens/agent-overview/Ui2AgentsFleetPage";

describe("myrmidon(UI2) route table integration", () => {
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
    expect(routedPaths.has("/company/settings/guards")).toBe(true);
    expect(routedPaths.has("/company/settings/not-a-real-page")).toBe(false);
  });

  it("routes every desktop rail navigation item to a unique, non-empty, and valid route", () => {
    const appSource = readFileSync(fileURLToPath(new URL("../../App.tsx", import.meta.url)), "utf8");
    const routeBlock = appSource.match(/function boardRoutes\([\s\S]*?(?=\nfunction )/)?.[0];
    expect(routeBlock).toBeDefined();

    const appPaths = new Set(
      [...routeBlock!.matchAll(/path="([^"]+)"/g)].map(([, path]) => `/${path}`),
    );
    const ui2Paths = new Set(UI2_ROUTE_TABLE.map((entry) => `/${entry.path}`));
    const routedPaths = new Set([...appPaths, ...ui2Paths]);

    const railItems = UI2_NAV_GROUPS.flatMap((group) => group.items);
    const railPaths = railItems.map((item) => item.to);

    // 1. None are empty
    for (const item of railItems) {
      expect(item.to).toBeTruthy();
      expect(item.to.startsWith("/")).toBe(true);
      expect(item.labelKey).toBeTruthy();
      expect(item.icon).toBeDefined();
    }

    // 2. No duplicates across rail navigation
    expect(new Set(railPaths).size).toBe(railPaths.length);

    // 3. Every destination resolves in board routes or UI2 route table
    for (const to of railPaths) {
      expect(routedPaths.has(to), `rail route ${to} resolves`).toBe(true);
    }
  });

  it("traverses the complete nav model verifying no empty or duplicate destinations across groups", () => {
    expect(UI2_NAV_GROUPS.length).toBeGreaterThan(0);
    const visitedTos = new Set<string>();

    for (const group of UI2_NAV_GROUPS) {
      expect(group.items.length).toBeGreaterThan(0);
      for (const item of group.items) {
        expect(item.to).toBeTruthy();
        expect(visitedTos.has(item.to), `duplicate destination ${item.to}`).toBe(false);
        visitedTos.add(item.to);
      }
    }

    // Settings sections also have no duplicate or empty destinations
    const settingsPaths = UI2_SETTINGS_SECTIONS.map((s) => s.path);
    expect(new Set(settingsPaths).size).toBe(settingsPaths.length);
    for (const path of settingsPaths) {
      expect(path).toBeTruthy();
      expect(path.startsWith("/company/settings")).toBe(true);
    }
  });

  it("ships exactly the contract entries, the fleet, the commander chat and the knowledge screens", () => {
    expect(UI2_ROUTE_TABLE.map((entry) => entry.key).sort()).toEqual([
      "agent-overview",
      "agents-fleet",
      "commander",
      "commander-chat",
      "costs",
      "decisions",
      "fleet",
      "knowledge",
      "knowledge-page",
      "more",
      "settings-autonomy-regulations",
      "settings-language",
      "settings-runs-queue",
      "settings-system",
    ]);
  });

  it("preserves full Secrets screen under UI2 without shadowing by a placeholder route", () => {
    // Under UI2, the secrets section must NOT be shadowed by UI2_ROUTE_TABLE placeholders,
    // allowing boardRoutes to serve the full Secrets screen with both instance secret references
    // and standard secret management tabs.
    const secretsUi2Route = UI2_ROUTE_TABLE.find((entry) => entry.path === "company/settings/secrets");
    expect(secretsUi2Route).toBeUndefined();

    const secretsSection = UI2_SETTINGS_SECTIONS.find((section) => section.key === "secrets");
    expect(secretsSection?.path).toBe("/company/settings/secrets");
  });

  it("marks the knowledge and regulations nav items as gated on the knowledge API", () => {
    const items = UI2_NAV_GROUPS.flatMap((group) => group.items);
    for (const to of ["/knowledge", "/company/settings/autonomy/regulations"]) {
      expect(items.find((item) => item.to === to)?.requires).toBe("knowledge");
    }
  });

  it("includes mobile launcher-only visibility and dynamic height behavior", () => {
    const phone = readFileSync(fileURLToPath(new URL("../shell/Ui2PhoneNav.tsx", import.meta.url)), "utf8");
    expect(phone).toContain("const hasPlugins = pluginSlots.length > 0 || launchers.length > 0");
    expect(phone).toContain("ResizeObserver");
    expect(phone).toContain("useUi2I18n");
  });

  it("keeps the agents and servers routes reachable from both desktop and phone navigation", () => {
    expect(UI2_NAV_GROUPS.flatMap((group) => group.items).filter((item) => item.to === "/agents")).toHaveLength(1);
    expect(UI2_PHONE_TABS.filter((item) => item.to === "/agents")).toHaveLength(1);
    expect(UI2_NAV_GROUPS.flatMap((group) => group.items).filter((item) => item.to === "/fleet")).toHaveLength(1);
    expect(UI2_PHONE_TABS.filter((item) => item.to === "/fleet")).toHaveLength(1);
    expect(UI2_PHONE_TABS.some((item) => item.to === "/more")).toBe(true);
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
    expect(byKey.get("more")?.path).toBe("more");
    expect(byKey.get("settings-runs-queue")?.path).toBe("company/settings/runs-queue");
    expect(byKey.get("settings-system")?.path).toBe("company/settings/system");
    expect(byKey.get("settings-language")?.path).toBe("company/settings/language");
    expect(byKey.get("decisions")?.legacyPath).toBe("/decisions");
    expect(byKey.get("costs")?.legacyPath).toBe("/activity/costs");
    expect(byKey.get("agent-overview")?.legacyPath).toBe("/agents/:agentId");
    expect(byKey.get("agents-fleet")?.legacyPath).toBe("/agents");
    expect(byKey.get("more")?.legacyPath).toBe("/agents/all");
  });

  it("activates exactly one tab at /agents in the six-tab phone grid", () => {
    expect(UI2_PHONE_TABS).toHaveLength(6);
    const active = UI2_PHONE_TABS.filter((tab) => isUi2PhoneTabActive(tab.to, "/agents"));
    expect(active.map((tab) => tab.labelKey)).toEqual(["ui2.nav.agents"]);
  });

  it("activates only More at /more in the six-tab phone grid", () => {
    expect(UI2_PHONE_TABS).toHaveLength(6);
    const active = UI2_PHONE_TABS.filter((tab) => isUi2PhoneTabActive(tab.to, "/more"));
    expect(active.map((tab) => tab.labelKey)).toEqual(["ui2.nav.more"]);
  });

  it("activates only More at /{P}/more in the six-tab phone grid", () => {
    const active = UI2_PHONE_TABS.filter((tab) => isUi2PhoneTabActive(tab.to, "/ACME/more"));
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
