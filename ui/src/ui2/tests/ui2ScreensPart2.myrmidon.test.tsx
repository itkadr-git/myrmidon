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
// part-2 wire surfaces (Guardrails 2.11, Budgets 2.9) additionally get
// behavioral mount tests here — rendered against mocked API clients, no
// server, no board.
//
// Guardrails note: the live screen lives at /company/settings/guardrails
// (GRD-MODES), mounted from the vendor route tree of App.tsx; the legacy
// settings slot /company/settings/guards (OPE-10138) is intentionally still
// the ui2 placeholder, so a direct URL lands on an honest placeholder card
// instead of a 404. The route test below pins the positive existence of the
// real guardrails route via matchRoutes + the App.tsx wiring, and the mount
// tests prove the real Guardrails screen renders with data.
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { matchRoutes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { UI2_ROUTE_TABLE, isUi2RouteElementAPlaceholder } from "../routes";
import { UI2_SETTINGS_SECTIONS } from "../shell/Ui2SettingsSidebar";
import { UI2_NAV_GROUPS, UI2_PHONE_TABS } from "../navModel";
import { GuardrailsScreen } from "../../components/myrmidon/guardrails/GuardrailsScreenContainer";
import { BudgetLimitsScreen } from "../../components/myrmidon/budget-limits/BudgetLimitsScreenContainer";
import type { GuardrailModesSettings, ResolvedGuardrailMode } from "@myrmidon/shared";
import type {
  BudgetLimitView,
  BudgetLimitUsageRow,
  BudgetLimitsSignalOnlyView,
} from "../../components/myrmidon/budget-limits/budgetLimitsApi";

// Wire mocks for the mount tests — the same mock shapes as the container
// suites of GRD-MODES and BUDGET-CONFIG D.
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
    // Sizes: 17 families on the surfaces above, plus the ru twins, the Nav
    // piece and PhoneMore — the 23 boards of the mockup.
    expect(routeKeys.size).toBe(16);
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
});

// ---------------------------------------------------------------------------
// Mount harness (fresh container + query client per test, act-based).
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
