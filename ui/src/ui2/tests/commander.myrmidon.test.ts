// @vitest-environment jsdom

// myrmidon(UI2): route, navigation, locales, widget sources, and empty states guards
// for the Commander screen (/{P}/commander) per ia-v2 §4.
import React, { type AnchorHTMLAttributes } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UI2_ROUTE_TABLE } from "../routes";
import { UI2_NAV_GROUPS, UI2_PHONE_TABS } from "../navModel";
import { UI2_MESSAGES } from "../i18n/locales";
import { Ui2I18nProvider } from "../i18n/Ui2I18n";
import { Ui2Commander } from "../screens/commander/Ui2Commander";

const mockApi = vi.hoisted(() => ({
  dashboardSummary: vi.fn(),
  liveRuns: vi.fn(),
  approvalsList: vi.fn(),
  decisionsList: vi.fn(),
  attentionList: vi.fn(),
}));

vi.mock("@/api/dashboard", () => ({
  dashboardApi: { summary: mockApi.dashboardSummary },
}));

vi.mock("@/api/heartbeats", () => ({
  heartbeatsApi: { liveRunsForCompany: mockApi.liveRuns },
}));

vi.mock("@/api/approvals", () => ({
  approvalsApi: { list: mockApi.approvalsList },
}));

vi.mock("@/api/decisions", () => ({
  decisionsApi: { list: mockApi.decisionsList },
}));

vi.mock("@/api/attention", () => ({
  attentionApi: { list: mockApi.attentionList },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "test-company-1" }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) =>
    React.createElement("a", { href: to, ...props }, children),
}));

async function settle() {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => window.setTimeout(resolve, 0));
  flushSync(() => {});
}

describe("myrmidon(UI2) commander route and navigation contracts", () => {
  it("registers the company-prefixed route separately from chat with correct titleKey and legacyPath", () => {
    const routes = new Map(UI2_ROUTE_TABLE.map((entry) => [entry.key, entry]));
    const commanderRoute = routes.get("commander");
    expect(commanderRoute?.path).toBe("commander");
    expect(commanderRoute?.titleKey).toBe("ui2.screens.commander");
    expect(commanderRoute?.legacyPath).toBe("/dashboard");
    expect(commanderRoute?.element).toBeTruthy();

    const chatRoute = routes.get("commander-chat");
    expect(chatRoute?.path).toBe("commander-chat");
    expect(chatRoute?.titleKey).toBe("ui2.screens.commanderChat");
  });

  it("wires /commander as Command Center in navigation while keeping /commander-chat accessible", () => {
    const desktopItems = UI2_NAV_GROUPS.flatMap((g) => g.items);
    const centerItem = desktopItems.find((i) => i.labelKey === "ui2.nav.center");
    expect(centerItem?.to).toBe("/commander");

    const chatItem = desktopItems.find((i) => i.labelKey === "ui2.nav.commander");
    expect(chatItem?.to).toBe("/commander-chat");

    const phoneCenter = UI2_PHONE_TABS.find((i) => i.labelKey === "ui2.nav.center");
    expect(phoneCenter?.to).toBe("/commander");

    const phoneChat = UI2_PHONE_TABS.find((i) => i.labelKey === "ui2.nav.commander");
    expect(phoneChat?.to).toBe("/commander-chat");
  });

  it("defines ui2.screens.commander in both EN and RU locales", () => {
    expect(UI2_MESSAGES.en["ui2.screens.commander"]).toBe("Command Center");
    expect(UI2_MESSAGES.ru["ui2.screens.commander"]).toBe("Командный центр");
  });
});

describe("myrmidon(UI2) commander widget sources and empty states (ia-v2 §4)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let client: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
      },
    });
  });

  afterEach(() => {
    root?.unmount();
    client.clear();
    container.remove();
    vi.clearAllMocks();
  });

  async function renderScreen(locale: "en" | "ru" = "en") {
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(
            Ui2I18nProvider,
            { initialLocale: locale },
            React.createElement(Ui2Commander)
          )
        )
      );
    });
    await settle();
  }

  it("renders live data matching API sources across all widgets", async () => {
    mockApi.dashboardSummary.mockResolvedValue({
      agents: { active: 10, running: 4, paused: 2, error: 1 },
      budgets: { activeIncidents: 0, pendingApprovals: 2, pausedAgents: 0, pausedProjects: 0 },
      runActivity: [],
    });
    mockApi.liveRuns.mockResolvedValue([
      {
        id: "run-101",
        agentName: "Agent-Alpha",
        status: "running",
        currentStatusMessage: "Executing migration step",
      },
      {
        id: "run-102",
        agentName: "Agent-Beta",
        status: "running",
        currentStatusMessage: "Running test suite",
      },
    ]);
    mockApi.approvalsList.mockResolvedValue([{ id: "app-1" }, { id: "app-2" }]);
    mockApi.decisionsList.mockResolvedValue([{ id: "dec-1" }]);
    mockApi.attentionList.mockResolvedValue({
      deskBadgeCount: 4,
      countsBySourceKind: { issue_thread_interaction: 1 },
    });

    await renderScreen("en");

    // Attention widget numbers
    expect(container.textContent).toContain("Needs attention");
    expect(container.textContent).toContain("Waiting total");
    expect(container.textContent).toContain("4"); // deskBadgeCount
    expect(container.textContent).toContain("Approvals");
    expect(container.textContent).toContain("2"); // pendingApprovals
    expect(container.textContent).toContain("Decisions");
    expect(container.textContent).toContain("1"); // openDecisions
    expect(container.textContent).toContain("Thread requests");

    // Active runs widget
    expect(container.textContent).toContain("Active runs");
    expect(container.textContent).toContain("Agent-Alpha");
    expect(container.textContent).toContain("Executing migration step");
    expect(container.textContent).toContain("Agent-Beta");
    expect(container.textContent).toContain("Running test suite");

    // Fleet attention widget & counters
    expect(container.textContent).toContain("Fleet attention");
    expect(container.textContent).toContain("Active agents");
    expect(container.textContent).toContain("10");
    expect(container.textContent).toContain("Running now");
    expect(container.textContent).toContain("Paused");
    expect(container.textContent).toContain("Errors");
    expect(container.textContent).toContain("1 agent(s) need attention");
    expect(container.querySelector('a[href="/agents"]')).toBeTruthy();
  });

  it("renders empty states when API sources return zero items", async () => {
    mockApi.dashboardSummary.mockResolvedValue(null);
    mockApi.liveRuns.mockResolvedValue([]);
    mockApi.approvalsList.mockResolvedValue([]);
    mockApi.decisionsList.mockResolvedValue([]);
    mockApi.attentionList.mockResolvedValue({
      deskBadgeCount: 0,
      countsBySourceKind: {},
    });

    await renderScreen("en");

    // Empty state messages per ia-v2 §4
    expect(container.textContent).toContain("Nothing needs your attention.");
    expect(container.textContent).toContain("No active runs right now.");
    expect(container.textContent).toContain("Fleet data is not available yet.");
  });

  it("renders empty states in Russian locale", async () => {
    mockApi.dashboardSummary.mockResolvedValue(null);
    mockApi.liveRuns.mockResolvedValue([]);
    mockApi.approvalsList.mockResolvedValue([]);
    mockApi.decisionsList.mockResolvedValue([]);
    mockApi.attentionList.mockResolvedValue({
      deskBadgeCount: 0,
      countsBySourceKind: {},
    });

    await renderScreen("ru");

    expect(container.textContent).toContain("Командный центр");
    expect(container.textContent).toContain("Ничего не требует внимания.");
    expect(container.textContent).toContain("Сейчас нет активных прогонов.");
    expect(container.textContent).toContain("Данные о флоте пока недоступны.");
  });
});
