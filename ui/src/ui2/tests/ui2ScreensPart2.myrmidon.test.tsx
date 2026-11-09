// @vitest-environment jsdom
// ui/src/ui2/tests/ui2ScreensPart2.myrmidon.test.tsx
//
// myrmidon(OPE-3918): part 2 of the UI-2.0 screens — Fleet (2.4), Budgets
// (2.9), Guardrails (2.11), Channels/Access/audit (2.15), Commander (2.3),
// plus the reconciliation of 2.2 Decisions, 2.6 Agent card, 2.7 Costs,
// 2.8 Quality, 2.10 Autonomy matrix, 2.16 Language against the mockup.
//
// Verified against the screen-map §2.19 summary table (OPE-3546): 17 named
// screen families on the canvas + the ru phone twins (Main.ru / Waiting.ru)
// + the Nav piece (2.17) + PhoneMore (2.18) = the 23 boards of the mockup.
// Each family is pinned to its live ui2 or vendor route surface, and the
// part-2 wire surfaces are mounted behaviorally here — rendered against
// mocked API clients, no server, no board:
//   - Guardrails 2.11 (settings/agents/resolve reads, error, no-company);
//   - Budgets 2.9 (reads + usage row, no-company);
//   - Fleet 2.4 with MONITORING (host/service rows from the dashboard read)
//     and SERVER-ONBOARD (site cards, bots via the site-bots read, the
//     add-site form);
//   - Commander 2.3 (attention tiles, active runs, fleet widget);
//   - Channels/Access 2.15 (tab switch voice → access, the access tab reads
//     the instance mode + allowlist + bot endpoints and renders rows).
//
// Guardrails note: the live screen lives at /company/settings/guardrails
// (GRD-MODES), mounted from the vendor route tree of App.tsx; the legacy
// settings slot /company/settings/guards (OPE-10138) is intentionally still
// the ui2 placeholder, so a direct URL lands on an honest placeholder card
// instead of a 404. The route test below pins the positive existence of the
// real guardrails route via matchRoutes + the App.tsx wiring, and the mount
// tests prove the real Guardrails screen renders with data.
import { act, type AnchorHTMLAttributes, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, matchRoutes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { UI2_ROUTE_TABLE, isUi2RouteElementAPlaceholder } from "../routes";
import { UI2_SETTINGS_SECTIONS } from "../shell/Ui2SettingsSidebar";
import { UI2_NAV_GROUPS, UI2_PHONE_TABS } from "../navModel";
import { Ui2I18nProvider } from "../i18n/Ui2I18n";
import { GuardrailsScreen } from "../../components/myrmidon/guardrails/GuardrailsScreenContainer";
import { BudgetLimitsScreen } from "../../components/myrmidon/budget-limits/BudgetLimitsScreenContainer";
import { Ui2Fleet } from "../screens/fleet/Ui2Fleet";
import { Ui2Commander } from "../screens/commander/Ui2Commander";
import { Ui2ChannelsSettings } from "../screens/settings/channels/Ui2ChannelsSettings";
import type { GuardrailModesSettings, ResolvedGuardrailMode } from "@myrmidon/shared";
import type {
  BudgetLimitView,
  BudgetLimitUsageRow,
  BudgetLimitsSignalOnlyView,
} from "../../components/myrmidon/budget-limits/budgetLimitsApi";
import type {
  FleetDashboard,
  FleetOomSummary,
  FleetSiteOverview,
  FleetSiteBot,
} from "@/api/fleet";
import type { ChannelSettingsView } from "../../components/myrmidon/channel-allowlist/channelSettingsApi";
import type { ChatEndpoint } from "@/api/chatEndpoints";
import type { ChannelAllowedUser } from "@myrmidon/shared";

// Wire mocks for the mount tests — the same mock shapes as the container
// suites of GRD-MODES, BUDGET-CONFIG D, the fleet parity suite and the
// channels suites.
const guardrailsApiMock = vi.hoisted(() => ({
  getSettings: vi.fn(),
  putSettings: vi.fn(),
  resolveForAgent: vi.fn(),
  listEvents: vi.fn(),
}));

const agentsApiMock = vi.hoisted(() => ({ list: vi.fn() }));

const budgetLimitsApiMock = vi.hoisted(() => ({
  list: vi.fn(),
  usage: vi.fn(),
  journal: vi.fn(),
  getSignalOnly: vi.fn(),
  patchSignalOnly: vi.fn(),
  saveLimit: vi.fn(),
  removeLimit: vi.fn(),
}));

const projectsApiMock = vi.hoisted(() => ({ list: vi.fn() }));

const journalMock = vi.hoisted(() => vi.fn());

const fleetApiMock = vi.hoisted(() => ({
  dashboard: vi.fn(),
  oomSummary: vi.fn(),
  sitesOverview: vi.fn(),
  siteBots: vi.fn(),
  drainSite: vi.fn(),
  resumeSite: vi.fn(),
  restartBot: vi.fn(),
  stopBot: vi.fn(),
  moveBot: vi.fn(),
  botLogs: vi.fn(),
  enrollSite: vi.fn(),
}));

const dashboardApiMock = vi.hoisted(() => ({ summary: vi.fn() }));
const heartbeatsApiMock = vi.hoisted(() => ({ liveRunsForCompany: vi.fn() }));
const approvalsApiMock = vi.hoisted(() => ({ list: vi.fn() }));
const decisionsApiMock = vi.hoisted(() => ({ list: vi.fn() }));
const attentionApiMock = vi.hoisted(() => ({ list: vi.fn() }));

const channelSettingsApiMock = vi.hoisted(() => ({
  read: vi.fn(),
  setAccessMode: vi.fn(),
}));
const channelAllowlistApiMock = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  revoke: vi.fn(),
  restore: vi.fn(),
}));
const chatEndpointsApiMock = vi.hoisted(() => ({ list: vi.fn() }));
const voiceSttApiMock = vi.hoisted(() => ({
  view: vi.fn(),
  update: vi.fn(),
}));

vi.mock(
  "../../components/myrmidon/guardrails/guardrailsApi",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../components/myrmidon/guardrails/guardrailsApi")
    >()),
    guardrailsApi: guardrailsApiMock,
    guardrailsSettingsQueryKey: (companyId: string) => [
      "myrmidon",
      "guardrails",
      "settings",
      companyId,
    ],
    guardrailsEventsQueryKey: (companyId: string, filters: unknown) => [
      "myrmidon",
      "guardrails",
      "events",
      companyId,
      filters,
    ],
  }),
);

vi.mock("@/api/agents", () => ({ agentsApi: agentsApiMock }));

vi.mock("../../components/myrmidon/guardrails/GuardrailsJournal", () => ({
  GuardrailsJournal: journalMock.mockImplementation(
    (props: { filters: unknown }) => (
      <div data-testid="guardrails-journal-stub" data-filters={JSON.stringify(props.filters)} />
    ),
  ),
}));

vi.mock(
  "../../components/myrmidon/budget-limits/budgetLimitsApi",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../components/myrmidon/budget-limits/budgetLimitsApi")
    >()),
    budgetLimitsApi: budgetLimitsApiMock,
  }),
);

vi.mock("@/api/projects", () => ({ projectsApi: projectsApiMock }));

vi.mock("@/api/fleet", () => ({ fleetApi: fleetApiMock }));

vi.mock("@/api/dashboard", () => ({ dashboardApi: dashboardApiMock }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: heartbeatsApiMock }));
vi.mock("@/api/approvals", () => ({ approvalsApi: approvalsApiMock }));
vi.mock("@/api/decisions", () => ({ decisionsApi: decisionsApiMock }));
vi.mock("@/api/attention", () => ({ attentionApi: attentionApiMock }));

vi.mock("@/lib/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/router")>();
  return {
    ...actual,
    // The commander fleet widget renders a Link to /agents; the smoke mount
    // runs without a router, so render a plain anchor instead.
    Link: ({
      to,
      children,
      ...props
    }: { to: string; children?: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) =>
      <a href={to} {...props}>{children}</a>,
  };
});

vi.mock("../../components/myrmidon/channel-allowlist/channelSettingsApi", () => ({
  channelSettingsApi: channelSettingsApiMock,
  channelSettingsQueryKey: ["myrmidon", "channel-settings"],
}));

vi.mock("../../components/myrmidon/channel-allowlist/channelAllowlistApi", () => ({
  channelAllowlistApi: channelAllowlistApiMock,
  channelAllowlistQueryKey: (companyId: string) => [
    "myrmidon",
    "channel-allowlist",
    companyId,
  ],
}));

vi.mock("@/api/chatEndpoints", () => ({ chatEndpointsApi: chatEndpointsApiMock }));

vi.mock("@/components/myrmidon/voice-stt/voiceSttApi", () => ({
  voiceSttApi: voiceSttApiMock,
  voiceSttQueryKey: (companyId: string) => ["voice-stt", companyId],
  VOICE_STT_BACKENDS: ["dashscope", "deepgram"],
  VOICE_STT_LANGUAGES: ["auto", "ru"],
}));

let selectedCompanyId = "company-1";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Screen-map §2.19 → live routes map (the 23 boards of the mockup).
// ---------------------------------------------------------------------------

/** Every `path="…"` of the vendor boardRoutes block in App.tsx. */
function vendorRoutePaths(): Set<string> {
  const appSource = readFileSync(
    resolve(__dirname, "../../App.tsx"),
    "utf8",
  );
  const routeBlock = appSource.match(/function boardRoutes\([\s\S]*?(?=\nfunction )/)?.[0];
  expect(routeBlock, "boardRoutes block in App.tsx").toBeDefined();
  return new Set([...routeBlock!.matchAll(/path="([^"]+)"/g)].map(([, path]) => `/${path}`));
}

function appSource(): string {
  return readFileSync(resolve(__dirname, "../../App.tsx"), "utf8");
}

const GUARDRAILS_PATH = "/company/settings/guardrails";
const BUDGETS_PATH = "/company/settings/budgets";
const CHANNELS_PATH = "/company/settings/channels";

describe("myrmidon(OPE-3918) UI-2.0 screens part 2 — screen-map §2.19 coverage", () => {
  it("pins the 23 mockup boards to live ui2 or vendor routes", () => {
    const routeKeys = new Set(UI2_ROUTE_TABLE.map((e) => e.key));
    const routePaths = new Set(UI2_ROUTE_TABLE.map((e) => `/${e.path}`));
    const sidebarKeys = new Set(UI2_SETTINGS_SECTIONS.map((s) => s.key));
    const vendorPaths = vendorRoutePaths();
    const railPaths = new Set(UI2_NAV_GROUPS.flatMap((g) => g.items).map((i) => i.to));
    const phoneTabs = new Set(UI2_PHONE_TABS.map((t) => t.to));
    const liveSurfaces = new Set([...routePaths, ...vendorPaths]);

    // No ui2 route entry is left on the shell placeholder.
    for (const entry of UI2_ROUTE_TABLE) {
      expect(isUi2RouteElementAPlaceholder(entry.element), `entry ${entry.key}`).toBe(false);
    }

    // 2.1 Main + PhoneCenter (Main.ru is the ru twin of the same route).
    expect(routeKeys.has("commander")).toBe(true);
    expect(railPaths.has("/commander")).toBe(true);
    expect(phoneTabs.has("/commander")).toBe(true);
    // 2.2 Waiting + PhoneWaiting (+ Waiting.ru twin).
    expect(routeKeys.has("decisions")).toBe(true);
    expect(railPaths.has("/decisions")).toBe(true);
    expect(phoneTabs.has("/decisions")).toBe(true);
    // 2.3 Chat + PhoneChat: Полководец.
    expect(routeKeys.has("commander-chat")).toBe(true);
    expect(railPaths.has("/commander-chat")).toBe(true);
    expect(phoneTabs.has("/commander-chat")).toBe(true);
    // 2.4 Fleet + PhoneFleet.
    expect(routeKeys.has("fleet")).toBe(true);
    expect(railPaths.has("/fleet")).toBe(true);
    expect(phoneTabs.has("/fleet")).toBe(true);
    // 2.5 Swarm.
    expect(railPaths.has("/swarm-claim")).toBe(true);
    expect(liveSurfaces.has("/swarm-claim")).toBe(true);
    // 2.6 Agent card + the agents list.
    expect(routeKeys.has("agent-overview")).toBe(true);
    expect(routeKeys.has("agents-fleet")).toBe(true);
    expect(railPaths.has("/agents")).toBe(true);
    // 2.7 Costs.
    expect(routeKeys.has("costs")).toBe(true);
    expect(routePaths.has("/activity/costs")).toBe(true);
    // 2.8 Quality.
    expect(railPaths.has("/quality")).toBe(true);
    expect(liveSurfaces.has("/quality")).toBe(true);
    // 2.9 Budgets and limits (BUDGET-CONFIG).
    expect(sidebarKeys.has("budgets")).toBe(true);
    expect(liveSurfaces.has(BUDGETS_PATH)).toBe(true);
    // 2.10 Autonomy matrix (with the regulations deep link).
    expect(liveSurfaces.has("/company/settings/autonomy")).toBe(true);
    expect(routeKeys.has("settings-autonomy-regulations")).toBe(true);
    // 2.11 Guardrails — the real GRD-MODES route.
    expect(liveSurfaces.has(GUARDRAILS_PATH)).toBe(true);
    // 2.12 Castes and models.
    expect(sidebarKeys.has("castes")).toBe(true);
    expect(liveSurfaces.has("/company/settings/castes")).toBe(true);
    expect(liveSurfaces.has("/company/settings/models")).toBe(true);
    // 2.13 Runs and queue.
    expect(routeKeys.has("settings-runs-queue")).toBe(true);
    expect(sidebarKeys.has("runs")).toBe(true);
    // 2.14 Foraging.
    expect(railPaths.has("/foraging")).toBe(true);
    expect(liveSurfaces.has("/foraging")).toBe(true);
    // 2.15 Channels, access, audit log.
    expect(routeKeys.has("settings-channels")).toBe(true);
    expect(sidebarKeys.has("channels")).toBe(true);
    expect(sidebarKeys.has("access")).toBe(true);
    expect(liveSurfaces.has("/company/settings/access-hub")).toBe(true);
    // 2.16 Language and formats.
    expect(routeKeys.has("settings-language")).toBe(true);
    expect(sidebarKeys.has("language")).toBe(true);
    // 2.17 Nav + 2.18 PhoneMore.
    expect(routeKeys.has("more")).toBe(true);
    expect(phoneTabs.has("/more")).toBe(true);
    expect(railPaths.has("/company/settings")).toBe(true);
    // Sizes: 15 route entries (the in-app screen families outside the
    // settings hub), 11 settings sections, 5 rail groups, 6 phone tabs —
    // together they cover the 17 mockup families; + ru twins, the Nav
    // piece and PhoneMore = the 23 boards of the mockup.
    expect(routeKeys.size).toBe(15);
    expect(UI2_SETTINGS_SECTIONS.length).toBe(11);
    expect(UI2_NAV_GROUPS.length).toBe(5);
    expect(UI2_PHONE_TABS.length).toBe(6);
  });

  it("resolves the real Guardrails route; the /guards slot stays the OPE-10138 placeholder shim", () => {
    const routes = [...vendorRoutePaths(), ...UI2_ROUTE_TABLE.map((e) => `/${e.path}`)].map(
      (path) => ({ path }),
    );
    expect(matchRoutes(routes, GUARDRAILS_PATH), "guardrails route resolves").not.toBeNull();

    const source = appSource();
    // The real screen is mounted at /company/settings/guardrails.
    expect(source).toMatch(
      /<Route path="company\/settings\/guardrails" element=\{<GuardrailsScreen \/>\} \/>/,
    );
    // The stale slot keeps its honest placeholder instead of a 404.
    expect(source).toMatch(
      /<Route path="company\/settings\/guards" element=\{<Ui2PlaceholderScreen \/>\} \/>/,
    );
  });

  it("fires the Guardrails reads for the selected company and renders modes, resolved chain and the journal", async () => {
    const settings: GuardrailModesSettings = {
      company: { secret: "mask" },
      castes: {},
      agents: {},
      injectionConfig: { enabled: false, scoreThreshold: 0.6 },
    };
    const resolved: ResolvedGuardrailMode[] = [
      { rule: "secret", mode: "mask", source: "company", caste: null },
    ];
    guardrailsApiMock.getSettings.mockResolvedValue(settings);
    guardrailsApiMock.resolveForAgent.mockResolvedValue(resolved);
    agentsApiMock.list.mockResolvedValue([{ id: "agent-1", name: "worker-1" }]);

    const { container } = await mount(<GuardrailsScreen />);

    expect(guardrailsApiMock.getSettings).toHaveBeenCalledWith("company-1");
    expect(agentsApiMock.list).toHaveBeenCalledWith("company-1");
    expect(guardrailsApiMock.resolveForAgent).toHaveBeenCalledWith("company-1", "agent-1");
    expect(container.querySelector('[data-testid="myrmidon-guardrails"]')).not.toBeNull();
    // The journal block is mounted with its filter state.
    expect(container.querySelector('[data-testid="guardrails-journal-stub"]')).not.toBeNull();
    expect(container.textContent).toContain("worker-1");
  });

  it("shows the Guardrails no-company notice without firing any request", async () => {
    selectedCompanyId = "";
    const { container } = await mount(<GuardrailsScreen />);
    expect(
      container.querySelector('[data-testid="myrmidon-guardrails-no-company"]'),
    ).not.toBeNull();
    expect(guardrailsApiMock.getSettings).not.toHaveBeenCalled();
    expect(agentsApiMock.list).not.toHaveBeenCalled();
  });

  it("shows the Guardrails error state when the settings read fails", async () => {
    guardrailsApiMock.getSettings.mockRejectedValue(new Error("settings unavailable"));
    agentsApiMock.list.mockResolvedValue([]);
    const { container } = await mount(<GuardrailsScreen />);
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="myrmidon-guardrails-error"]')).not.toBeNull();
    });
    expect(container.querySelector('[data-testid="myrmidon-guardrails-error"]')?.textContent).toContain(
      "settings unavailable",
    );
  });

  it("mounts the Budgets screen: the reads fire for the selected company and rows render", async () => {
    const limit: BudgetLimitView = {
      id: "id-nest-company",
      companyId: "company-1",
      level: "nest",
      ref: "company",
      amountCents: 50000,
      period: "calendar_month_utc",
      mode: "hard",
      isActive: true,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    const usage: BudgetLimitUsageRow[] = [
      { ...limit, spentCents: 60000, events: 3, overLimit: true },
    ];
    const signalOnly: BudgetLimitsSignalOnlyView = { signalOnly: true, source: "stored" };
    budgetLimitsApiMock.list.mockResolvedValue([limit]);
    budgetLimitsApiMock.usage.mockResolvedValue(usage);
    budgetLimitsApiMock.journal.mockResolvedValue([]);
    budgetLimitsApiMock.getSignalOnly.mockResolvedValue(signalOnly);
    projectsApiMock.list.mockResolvedValue([]);

    const { container } = await mount(<BudgetLimitsScreen />);

    expect(budgetLimitsApiMock.list).toHaveBeenCalledWith("company-1");
    expect(budgetLimitsApiMock.usage).toHaveBeenCalledWith("company-1");
    expect(budgetLimitsApiMock.journal).toHaveBeenCalledWith("company-1");
    expect(budgetLimitsApiMock.getSignalOnly).toHaveBeenCalledWith("company-1");
    expect(projectsApiMock.list).toHaveBeenCalledWith("company-1");
    expect(container.querySelector('[data-testid="budget-limits-spent-nest:company"]')?.textContent).toContain(
      "$600.00",
    );
    expect(container.querySelector('[data-testid="budget-limits-amount-nest:company"]')).not.toBeNull();
  });

  it("shows the Budgets no-company notice without firing any request", async () => {
    selectedCompanyId = "";
    const { container } = await mount(<BudgetLimitsScreen />);
    expect(
      container.querySelector('[data-testid="myrmidon-budget-limits-no-company"]'),
    ).not.toBeNull();
    expect(budgetLimitsApiMock.list).not.toHaveBeenCalled();
    expect(budgetLimitsApiMock.usage).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 2.4 Fleet — MONITORING (the monitoring dashboard read renders host and
  // service rows) and SERVER-ONBOARD (execution sites render with capacity,
  // their bots come from the per-site bots read, and the add-site form is
  // reachable).
  // -------------------------------------------------------------------------
  it("mounts Fleet: the monitoring dashboard read renders hosts and services for the selected company", async () => {
    fleetApiMock.dashboard.mockResolvedValue(fleetDashboard());
    fleetApiMock.oomSummary.mockResolvedValue(fleetOom());
    fleetApiMock.sitesOverview.mockResolvedValue({ sites: [] });

    const { container } = await mountScreen(<Ui2Fleet />);

    expect(fleetApiMock.dashboard).toHaveBeenCalledWith("company-1");
    expect(fleetApiMock.oomSummary).toHaveBeenCalledWith("company-1");
    // MONITORING surface: the page title plus the host/service rows built
    // from the dashboard payload (not a placeholder, not an empty shell).
    expect(container.textContent).toContain("Servers");
    expect(container.textContent).toContain("node-a");
    expect(container.textContent).toContain("worker-a");
    expect(container.textContent).toContain("Running");
  });

  it("mounts Fleet SERVER-ONBOARD: sites render with capacity and their bots come from the per-site read", async () => {
    fleetApiMock.dashboard.mockResolvedValue(fleetDashboard());
    fleetApiMock.oomSummary.mockResolvedValue(fleetOom());
    fleetApiMock.sitesOverview.mockResolvedValue({ sites: [fleetSite()] });
    fleetApiMock.siteBots.mockResolvedValue({ site: "edge-1", bots: [fleetBot()] });

    const { container } = await mountScreen(<Ui2Fleet />);

    expect(fleetApiMock.sitesOverview).toHaveBeenCalledWith("company-1");
    // The site card renders from the overview read.
    expect(container.querySelector('[data-testid="site-edge-1"]')).not.toBeNull();
    expect(container.textContent).toContain("edge-1");
    // SERVER-ONBOARD wire: expanding the site fires the per-site bots read
    // and renders the bot row.
    (container.querySelector('[data-testid="site-edge-1"] button') as HTMLButtonElement).click();
    await settle();
    expect(fleetApiMock.siteBots).toHaveBeenCalledWith("company-1", "edge-1");
    expect(container.querySelector('[data-testid="bot-bot-edge-1"]')).not.toBeNull();
    expect(container.textContent).toContain("worker-edge");
    // The onboarding entry point (add-site form) is reachable.
    const addButtons = [...container.querySelectorAll("button")].filter(
      (button) => button.textContent === "Add a site",
    );
    expect(addButtons.length).toBeGreaterThan(0);
    addButtons[0]!.click();
    await settle();
    expect(container.querySelector('[data-testid="add-site-form"]')).not.toBeNull();
  });

  it("Fleet keeps its monitoring error surface when the dashboard read fails", async () => {
    fleetApiMock.dashboard.mockRejectedValue(new Error("dashboard unavailable"));
    fleetApiMock.oomSummary.mockResolvedValue(fleetOom());
    fleetApiMock.sitesOverview.mockResolvedValue({ sites: [] });

    const { container } = await mountScreen(<Ui2Fleet />);

    expect(container.textContent).toContain("Could not load this data. Try again.");
    expect(container.textContent).toContain("Retry");
  });

  // -------------------------------------------------------------------------
  // 2.3 Commander (Полководец) — the Command Center wires five live sources
  // and renders their numbers and rows.
  // -------------------------------------------------------------------------
  it("mounts Commander: attention tiles, active runs and the fleet widget render from the live sources", async () => {
    dashboardApiMock.summary.mockResolvedValue({
      agents: { active: 10, running: 4, paused: 2, error: 1 },
    });
    heartbeatsApiMock.liveRunsForCompany.mockResolvedValue([
      {
        id: "run-101",
        agentName: "Agent-Alpha",
        status: "running",
        currentStatusMessage: "Executing migration step",
      },
    ]);
    approvalsApiMock.list.mockResolvedValue([{ id: "app-1" }, { id: "app-2" }]);
    decisionsApiMock.list.mockResolvedValue([{ id: "dec-1" }]);
    attentionApiMock.list.mockResolvedValue({
      deskBadgeCount: 4,
      countsBySourceKind: { issue_thread_interaction: 1 },
    });

    const { container } = await mountScreen(<Ui2Commander />);

    expect(dashboardApiMock.summary).toHaveBeenCalledWith("company-1");
    expect(heartbeatsApiMock.liveRunsForCompany).toHaveBeenCalledWith("company-1", { limit: 25 });
    expect(approvalsApiMock.list).toHaveBeenCalledWith("company-1", "pending");
    expect(decisionsApiMock.list).toHaveBeenCalledWith("company-1", { status: "open" });
    expect(attentionApiMock.list).toHaveBeenCalledWith("company-1", { limit: 100 });
    // Attention widget numbers from the attention feed.
    expect(container.textContent).toContain("Needs attention");
    expect(container.textContent).toContain("Approvals");
    expect(container.textContent).toContain("Decisions");
    // Active runs rows.
    expect(container.textContent).toContain("Agent-Alpha");
    expect(container.textContent).toContain("Executing migration step");
    // Fleet widget counters from the dashboard summary.
    expect(container.textContent).toContain("Fleet attention");
    expect(container.querySelector('a[href="/agents"]')).not.toBeNull();
  });

  it("Commander renders its empty states when every source is empty", async () => {
    dashboardApiMock.summary.mockResolvedValue(null);
    heartbeatsApiMock.liveRunsForCompany.mockResolvedValue([]);
    approvalsApiMock.list.mockResolvedValue([]);
    decisionsApiMock.list.mockResolvedValue([]);
    attentionApiMock.list.mockResolvedValue({ deskBadgeCount: 0, countsBySourceKind: {} });

    const { container } = await mountScreen(<Ui2Commander />);

    expect(container.textContent).toContain("Nothing needs your attention.");
    expect(container.textContent).toContain("No active runs right now.");
    expect(container.textContent).toContain("Fleet data is not available yet.");
  });

  // -------------------------------------------------------------------------
  // 2.15 Channels and access — the settings screen mounts, the tab shell
  // switches voice → access, and the access tab wires the instance channel
  // mode, the allowlist and the bot endpoints.
  // -------------------------------------------------------------------------
  it("mounts Channels settings: the voice tab loads its view", async () => {
    voiceSttApiMock.view.mockResolvedValue({
      enabled: false,
      backend: "dashscope",
      model: null,
      language: "auto",
      diarization: false,
      maxDurationSec: 600,
    });

    const { container } = await mountScreen(
      <MemoryRouter initialEntries={[CHANNELS_PATH]}>
        <Ui2ChannelsSettings />
      </MemoryRouter>,
    );

    // The tabbed shell is mounted with both tabs.
    expect(container.querySelector('[data-testid="ui2-channels-tablist"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="ui2-channels-tab-voice"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="ui2-channels-tab-access"]')).not.toBeNull();
    // The default voice tab fires its read and renders its panel.
    expect(voiceSttApiMock.view).toHaveBeenCalled();
    expect(container.querySelector('[data-testid="ui2-channels-panel-voice"]')).not.toBeNull();
  });

  it("switches Channels to the access tab: the access reads fire and the allowlist renders", async () => {
    const settings: ChannelSettingsView = {
      channelAccessMode: {
        value: "allowlist",
        source: "ui",
        default: "sponsor",
        envName: "MYRMIDON_CHANNEL_ACCESS_MODE",
        overridden: false,
      },
    };
    const allowedUsers: ChannelAllowedUser[] = [
      {
        id: "row-1",
        companyId: "company-1",
        provider: "telegram",
        externalId: "tg-777",
        handle: "owner",
        displayName: "Owner",
        scope: "company",
        endpointId: null,
        boardUserId: null,
        status: "active",
        addedBy: null,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
    ];
    const endpoints: ChatEndpoint[] = [
      {
        id: "endpoint-1",
        companyId: "company-1",
        provider: "telegram",
        status: "ready",
        assignedAgentId: "agent-1",
        assignedAgentName: "worker-1",
        connectionId: null,
        providerAccountId: null,
        providerAccountLabel: null,
        botLabel: "board-bot",
        botUsername: "board_bot",
        botExternalId: "ext-1",
        allowUnlinkedPeople: false,
      } as unknown as ChatEndpoint,
    ];
    channelSettingsApiMock.read.mockResolvedValue(settings);
    channelAllowlistApiMock.list.mockResolvedValue({ allowedUsers });
    chatEndpointsApiMock.list.mockResolvedValue(endpoints);
    voiceSttApiMock.view.mockResolvedValue({
      enabled: false,
      backend: "dashscope",
      model: null,
      language: "auto",
      diarization: false,
      maxDurationSec: 600,
    });

    const { container } = await mountScreen(
      <MemoryRouter initialEntries={[CHANNELS_PATH]}>
        <Ui2ChannelsSettings />
      </MemoryRouter>,
    );
    await settle();

    // Switch to the access tab and wait for its reads.
    (
      container.querySelector('[data-testid="ui2-channels-tab-access"]') as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="ui2-channels-panel-access"]'),
      ).not.toBeNull();
    });
    await settle();

    expect(channelSettingsApiMock.read).toHaveBeenCalled();
    expect(channelAllowlistApiMock.list).toHaveBeenCalledWith("company-1");
    expect(chatEndpointsApiMock.list).toHaveBeenCalledWith("company-1");
    // The access surface renders the real rows from the allowlist read.
    expect(container.querySelector('[data-testid="ui2-channel-access-tab"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="ui2-channel-access-list"]')).not.toBeNull();
    expect(container.textContent).toContain("tg-777");
    expect(container.textContent).toContain("board-bot");
  });

  it("the access tab surfaces a load error when the channel settings read fails", async () => {
    channelSettingsApiMock.read.mockRejectedValue(new Error("channel settings unavailable"));
    channelAllowlistApiMock.list.mockResolvedValue({ allowedUsers: [] });
    chatEndpointsApiMock.list.mockResolvedValue([]);
    voiceSttApiMock.view.mockResolvedValue({
      enabled: false,
      backend: "dashscope",
      model: null,
      language: "auto",
      diarization: false,
      maxDurationSec: 600,
    });

    const { container } = await mountScreen(
      <MemoryRouter initialEntries={[CHANNELS_PATH]}>
        <Ui2ChannelsSettings />
      </MemoryRouter>,
    );
    await settle();
    (
      container.querySelector('[data-testid="ui2-channels-tab-access"]') as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="ui2-channel-access-load-error"]')).not.toBeNull();
    });
    expect(container.textContent).toContain("channel settings unavailable");
  });
});

// ---------------------------------------------------------------------------
// Shared fixture builders.
// ---------------------------------------------------------------------------

function fleetDashboard(): FleetDashboard {
  return {
    ok: true,
    generatedAt: "2026-10-20T00:00:00.000Z",
    sources: [],
    hosts: [
      {
        name: "node-a",
        origin: "victoriametrics",
        cpuPercent: 12,
        memoryPercent: 34,
        diskPercent: 56,
        ageSec: 10,
      },
    ],
    containers: [{ name: "worker-a", state: "running", cpuPercent: 1, memoryBytes: 1024 }],
    oomSummary: fleetOom(),
    blockerPanels: null,
  };
}

function fleetOom(): FleetOomSummary {
  return {
    windowStartedAt: "2026-10-20T00:00:00.000Z",
    total24h: 0,
    previous24h: 0,
    increaseAlert: false,
    byAgent: [],
    byRole: [],
  };
}

function fleetSite(): FleetSiteOverview {
  return {
    name: "edge-1",
    state: "healthy",
    status: "active",
    autoDrained: false,
    lastSeenAt: "2026-10-20T00:00:00.000Z",
    url: "https://edge-1.example.com",
    labels: {},
    clientCertNotAfter: "2030-01-01T00:00:00.000Z",
    certExpired: false,
    capacity: {
      cpus: { used: 1, total: 4 },
      memoryMb: { used: 512, total: 2048 },
      bots: { used: 1, total: 4 },
    },
    driftCount: 0,
    driftFields: [],
  } as unknown as FleetSiteOverview;
}

function fleetBot(): FleetSiteBot {
  return {
    botKey: "bot-edge-1",
    agentName: "worker-edge",
    state: "running",
    image: "ghcr.io/example/bot:latest",
    drift: false,
    driftFields: [],
    apiBaseUrl: null,
    gatewayPort: null,
    pinned: false,
  };
}

// ---------------------------------------------------------------------------
// Mount harness (fresh container + query client per test, act-based).
// The i18n provider wraps every screen: ui2 screens read their copy through
// useUi2I18n, so the mount tests assert the real rendered strings.
// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root | null;
let queryClient: QueryClient;

beforeEach(() => {
  selectedCompanyId = "company-1";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = null;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});

afterEach(() => {
  flushSync(() => root?.unmount());
  root = null;
  queryClient.clear();
  container.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(screen: React.ReactElement): Promise<{ container: HTMLDivElement }> {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>{screen}</QueryClientProvider>,
    );
  });
  await settle();
  return { container };
}

async function mountScreen(screen: React.ReactElement): Promise<{ container: HTMLDivElement }> {
  return mount(<Ui2I18nProvider initialLocale="en">{screen}</Ui2I18nProvider>);
}
