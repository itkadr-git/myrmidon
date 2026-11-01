// @vitest-environment jsdom
// ui/src/ui2/tests/ui2SettingsSections.myrmidon.test.tsx
//
// myrmidon(OPE-10138): regression test for the 11 UI-2.0 settings sections.
// Ensures that every settings destination:
// 1. Matches an application route (avoiding historical 404 / "Page not found" like OPE-9379).
// 2. Is marked active in Ui2SettingsSidebar only on its own path.
// 3. UI-2.0 screens render on mock API without throwing or showing error boundary text
//    (avoiding crashes like OPE-9381 "e.filter is not a function").

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, matchRoutes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { UI2_SETTINGS_SECTIONS, Ui2SettingsSidebar } from "../shell/Ui2SettingsSidebar";
import { UI2_ROUTE_TABLE } from "../routes";
import { Ui2RunsSettings } from "../screens/settings/runs-queue/Ui2RunsSettings";
import { Ui2SystemSettings } from "../screens/settings/system/Ui2SystemSettings";
import { Ui2LanguageSettings } from "../screens/settings/language/Ui2LanguageSettings";
import { Ui2PlaceholderScreen } from "../screens/Ui2PlaceholderScreen";
import { Ui2I18nProvider } from "../i18n/Ui2I18n";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const mockRuntimeLimitsApi = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  presets: vi.fn(),
}));

vi.mock("@/components/myrmidon/runtimeLimitsApi", () => ({
  runtimeLimitsApi: mockRuntimeLimitsApi,
  runtimeLimitsQueryKey: ["myrmidon", "runtime-limits"],
}));

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

vi.mock("@/api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

const mockAccessApi = vi.hoisted(() => ({
  listMembers: vi.fn(),
  listBoardApiKeys: vi.fn(),
  listInvites: vi.fn(),
}));

vi.mock("@/api/access", () => ({
  accessApi: mockAccessApi,
}));

const mockActivityApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("@/api/activity", () => ({
  activityApi: mockActivityApi,
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "company-a", issuePrefix: "OPE" },
    currentCompany: { id: "company-1", name: "company-a", issuePrefix: "OPE" },
  }),
}));

vi.mock("@/lib/router", async () => {
  const router = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...router };
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const UI_SRC = join(__dirname, "../..");
const ROUTE_TEST_SOURCE = readFileSync(join(UI_SRC, "App.tsx"), "utf8");

export function getApplicationSettingsRoutes(customAppSource = ROUTE_TEST_SOURCE): string[] {
  const source = customAppSource ?? readFileSync(join(UI_SRC, "App.tsx"), "utf8");
  const routeBlock = source.match(/function boardRoutes\([\s\S]*?(?=\nfunction )/)?.[0];
  if (!routeBlock) throw new Error("Unable to locate boardRoutes in App.tsx");
  const vendorPaths = [...routeBlock.matchAll(/path="(company\/settings(?:\/[^"]*)?)"/g)]
    .map(([, path]) => `/${path}`)
    .filter((path) => !path.includes(":") && !path.includes("*"));
  return Array.from(new Set([...UI2_ROUTE_TABLE.map((route) => `/${route.path}`), ...vendorPaths]));
}

export interface SettingsSectionSpec {
  name: string;
  path: string;
  sidebarKey: string | null;
  componentRenderer?: () => React.ReactElement;
}

export const SETTINGS_SECTION_SPECS: SettingsSectionSpec[] = [
  { name: "general", path: "/company/settings", sidebarKey: "general" },
  { name: "members", path: "/company/settings/members", sidebarKey: "members" },
  { name: "access-hub", path: "/company/settings/access-hub", sidebarKey: "access" },
  { name: "secrets", path: "/company/settings/secrets", sidebarKey: "secrets" },
  {
    name: "runs-queue",
    path: "/company/settings/runs-queue",
    sidebarKey: "runs",
    componentRenderer: () => <Ui2RunsSettings />,
  },
  { name: "budgets", path: "/company/settings/budgets", sidebarKey: "budgets" },
  { name: "autonomy", path: "/company/settings/autonomy", sidebarKey: "autonomy" },
  { name: "castes", path: "/company/settings/castes", sidebarKey: "castes" },
  {
    name: "system",
    path: "/company/settings/system",
    sidebarKey: "system",
    componentRenderer: () => <Ui2SystemSettings />,
  },
  {
    name: "language",
    path: "/company/settings/language",
    sidebarKey: null,
    componentRenderer: () => <Ui2LanguageSettings />,
  },
  {
    name: "guards",
    path: "/company/settings/guards",
    sidebarKey: null,
    componentRenderer: () => <Ui2PlaceholderScreen />,
  },
];

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("UI-2.0 Settings Sections Regression Suite (OPE-10138)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
      },
    });

    mockRuntimeLimitsApi.get.mockResolvedValue({
      limits: {
        maxConcurrentRuns: 5,
        maxStartsPerMinute: 10,
        minFreeMemoryMb: null,
        runMemoryEstimateMb: 1024,
        minFreeHostMemoryMb: null,
        maxHostLoadPercentPerCore: 90,
        maxPerAgentStartSharePercent: null,
      },
      sources: {
        maxConcurrentRuns: "default",
        maxStartsPerMinute: "default",
        minFreeMemoryMb: "default",
        runMemoryEstimateMb: "default",
        minFreeHostMemoryMb: "default",
        maxHostLoadPercentPerCore: "default",
        maxPerAgentStartSharePercent: "default",
      },
      hostLoad: {
        state: "open",
        thresholdPercent: 90,
        load1: 19.2,
        cores: 16,
        loadPercentPerCore: 120,
        backgroundPercentPerCore: 115,
        load15PercentPerCore: 115,
        loadAboveBackgroundPercent: 5,
        reason: null,
        heldSince: null,
      },
      queue: {
        active: 2,
        limit: 5,
        queued: 0,
        oldestQueuedAt: null,
        oldestQueuedAgentId: null,
      },
      memory: {
        host: { availableMb: 45056, totalMb: 131072 },
        container: { limitMb: 8192, usedMb: 3000, freeMb: 5192 },
      },
    });
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
    mockRuntimeLimitsApi.update.mockResolvedValue({});
    mockRuntimeLimitsApi.presets.mockResolvedValue([]);
    mockHeartbeatsApi.list.mockResolvedValue([]);
    mockAccessApi.listMembers.mockResolvedValue([]);
    mockAccessApi.listBoardApiKeys.mockResolvedValue([]);
    mockAccessApi.listInvites.mockResolvedValue([]);
    mockActivityApi.list.mockResolvedValue([]);
  });

  afterEach(() => {
    flushSync(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("covers all 11 settings sections requested by OPE-10138", () => {
    expect(SETTINGS_SECTION_SPECS).toHaveLength(11);
    const expectedNames = [
      "general",
      "members",
      "access-hub",
      "secrets",
      "runs-queue",
      "budgets",
      "autonomy",
      "castes",
      "system",
      "language",
      "guards",
    ];
    expect(SETTINGS_SECTION_SPECS.map((s) => s.name)).toEqual(expectedNames);
  });

  SETTINGS_SECTION_SPECS.forEach((spec) => {
    describe(`section: ${spec.name}`, () => {
      it(`${spec.name}: matches an application route (not Page not found)`, () => {
        const matches = matchRoutes(
          getApplicationSettingsRoutes(ROUTE_TEST_SOURCE).map((path) => ({ path })),
          spec.path,
        );
        expect(matches, `Path ${spec.path} must match a concrete application route`).not.toBeNull();
        expect(matches?.[0]?.route.path).toBe(spec.path);
      });

      it(`${spec.name}: sidebar active state is correct on ${spec.path}`, () => {
        const routeMatches = matchRoutes(getApplicationSettingsRoutes(ROUTE_TEST_SOURCE).map((path) => ({ path })), spec.path);

        flushSync(() => {
          root.render(
            <Ui2I18nProvider>
              <MemoryRouter initialEntries={[spec.path]}>
                <Ui2SettingsSidebar />
              </MemoryRouter>
            </Ui2I18nProvider>,
          );
        });

        expect(routeMatches, `Path ${spec.path} must be an application route`).not.toBeNull();
        const links = Array.from(container.querySelectorAll("a"));
        expect(links.length).toBe(UI2_SETTINGS_SECTIONS.length);

        for (const section of UI2_SETTINGS_SECTIONS) {
          const link = links.find((candidate) => {
            const href = candidate.getAttribute("href");
            const path = new URL(href ?? "/", window.location.origin).pathname;
            return path.endsWith(section.path);
          });
          expect(link, `NavLink for section ${section.key} (${section.path}) not found`).toBeDefined();

          const shouldBeActive = spec.sidebarKey === section.key;
          const isActive =
            link?.getAttribute("aria-current") === "page" ||
            link?.classList.contains("active") ||
            link?.style.background === "var(--myr-navy-deep)";

          expect(
            isActive,
            `Expected sidebar section "${section.key}" to be ${shouldBeActive ? "active" : "inactive"} when on "${spec.path}"`,
          ).toBe(shouldBeActive);
        }
      });

      if (spec.componentRenderer) {
        it(`${spec.name}: screen renders without exceptions or error boundary text`, async () => {
          flushSync(() => {
            root.render(
              <QueryClientProvider client={queryClient}>
                <Ui2I18nProvider>
                  <MemoryRouter initialEntries={[spec.path]}>
                    {spec.componentRenderer!()}
                  </MemoryRouter>
                </Ui2I18nProvider>
              </QueryClientProvider>,
            );
          });

          await flushReact();

          const text = container.textContent ?? "";
          expect(text).not.toContain("Page not found");
          expect(text).not.toContain("Something went wrong");
          expect(text).not.toContain("filter is not a function");
          expect(text).not.toContain("Unhandled error");
          expect(container.querySelector("section, main, [role='main']")).not.toBeNull();
        });
      }
    });
  });

  describe("guards route failure contract (acceptance criterion)", () => {
    it("guards: fails route matching if guards is missing from application routes", () => {
      const appSource = readFileSync(join(UI_SRC, "App.tsx"), "utf8");
      const appSourceWithoutGuards = appSource.replace(
        /<Route path="company\/settings\/guards" element=\{<Ui2PlaceholderScreen \/>\} \/>[^\n]*/,
        "",
      );
      expect(appSourceWithoutGuards).not.toBe(appSource);

      const routesWithoutGuards = getApplicationSettingsRoutes(appSourceWithoutGuards);
      expect(routesWithoutGuards).not.toContain("/company/settings/guards");

      const routerRoutes = routesWithoutGuards.map((p) => ({ path: p }));
      const match = matchRoutes(routerRoutes, "/company/settings/guards");
      expect(match).toBeNull();
    });
  });
});
