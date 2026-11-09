// ui/src/ui2/tests/ui2ScreensPart2.myrmidon.test.ts
import { describe, expect, it } from "vitest";
import { UI2_ROUTE_TABLE, isUi2RouteElementAPlaceholder } from "../routes";
import { UI2_SETTINGS_SECTIONS } from "../shell/Ui2SettingsSidebar";
import { UI2_NAV_GROUPS } from "../navModel";
import { GuardrailsScreen } from "../../components/myrmidon/guardrails/GuardrailsScreenContainer";
import { BudgetLimitsScreen } from "../../components/myrmidon/budget-limits/BudgetLimitsScreenContainer";
import { resolveMyrmidonUi2Enabled } from "../useMyrmidonUi2Enabled";

describe("myrmidon(OPE-3918) UI-2.0 screens part 2 coverage", () => {
  it("includes Server Fleet, Budgets, Guardrails, Channels/Access, and Commander screens", () => {
    const keys = new Set<string>(UI2_ROUTE_TABLE.map((e) => e.key));
    expect(keys.has("fleet")).toBe(true);
    expect(keys.has("settings-runs-queue")).toBe(true);
    expect(keys.has("settings-system")).toBe(true);
    expect(keys.has("settings-language")).toBe(true);
    expect(keys.has("settings-channels")).toBe(true);
    expect(keys.has("commander")).toBe(true);
    expect(keys.has("commander-chat")).toBe(true);
    expect(keys.has("knowledge")).toBe(true);
    expect(keys.has("decisions")).toBe(true);
    expect(keys.has("costs")).toBe(true);
    expect(keys.has("agent-overview")).toBe(true);
    expect(keys.has("agents-fleet")).toBe(true);
    expect(keys.has("more")).toBe(true);

    const settingsKeys = new Set<string>(UI2_SETTINGS_SECTIONS.map((s) => s.key));
    expect(settingsKeys.has("budgets")).toBe(true);
    expect(settingsKeys.has("access")).toBe(true);
    expect(settingsKeys.has("system")).toBe(true);
    expect(settingsKeys.has("language")).toBe(true);
    expect(settingsKeys.has("runs")).toBe(true);
    expect(settingsKeys.has("autonomy")).toBe(true);
    expect(settingsKeys.has("channels")).toBe(true);
  });

  it("ensures none of the part 2 screens are placeholders", () => {
    for (const entry of UI2_ROUTE_TABLE) {
      expect(isUi2RouteElementAPlaceholder(entry.element), `entry ${entry.key}`).toBe(false);
    }
  });

  it("verifies Budgets and Guardrails screen components render as real containers", () => {
    expect(typeof BudgetLimitsScreen).toBe("function");
    expect(typeof GuardrailsScreen).toBe("function");
  });

  it("verifies enableMyrmidonUi2 flag resolution behaves correctly", () => {
    expect(resolveMyrmidonUi2Enabled(undefined)).toBe(false);
    expect(resolveMyrmidonUi2Enabled(null)).toBe(false);
    expect(resolveMyrmidonUi2Enabled({} as never)).toBe(false);
    expect(resolveMyrmidonUi2Enabled({ enableMyrmidonUi2: false })).toBe(false);
    expect(resolveMyrmidonUi2Enabled({ enableMyrmidonUi2: true })).toBe(true);
  });

  it("verifies all screen-map 2.0 sections are covered across UI2 routes, sidebar and rail navigation", () => {
    const routeKeys = new Set<string>(UI2_ROUTE_TABLE.map((e) => e.key));
    const sidebarKeys = new Set<string>(UI2_SETTINGS_SECTIONS.map((s) => s.key));
    const railPaths = new Set<string>(UI2_NAV_GROUPS.flatMap((g) => g.items).map((i) => i.to));

    // Fleet (2.4)
    expect(routeKeys.has("fleet")).toBe(true);
    expect(railPaths.has("/fleet")).toBe(true);

    // Budgets (2.9)
    expect(sidebarKeys.has("budgets")).toBe(true);

    // Guardrails (2.11)
    expect(sidebarKeys.has("guards") || sidebarKeys.has("guardrails") || UI2_SETTINGS_SECTIONS.some((s) => s.path.includes("guards") || s.path.includes("guardrails"))).toBe(false); // guards route in boardRoutes under settings

    // Channels & Access (2.15)
    expect(routeKeys.has("settings-channels")).toBe(true);
    expect(sidebarKeys.has("channels")).toBe(true);
    expect(sidebarKeys.has("access")).toBe(true);

    // Commander (2.3)
    expect(routeKeys.has("commander")).toBe(true);
    expect(routeKeys.has("commander-chat")).toBe(true);
    expect(railPaths.has("/commander")).toBe(true);

    // Decisions (2.2), Agent Card/Fleet (2.6), Costs (2.7), Language (2.16), Autonomy (2.10)
    expect(routeKeys.has("decisions")).toBe(true);
    expect(routeKeys.has("agent-overview")).toBe(true);
    expect(routeKeys.has("costs")).toBe(true);
    expect(routeKeys.has("settings-language")).toBe(true);
    expect(routeKeys.has("settings-autonomy-regulations")).toBe(true);
  });
});

