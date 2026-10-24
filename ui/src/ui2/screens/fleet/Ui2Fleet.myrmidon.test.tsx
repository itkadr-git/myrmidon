// ui/src/ui2/screens/fleet/Ui2Fleet.myrmidon.test.tsx
// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ui2Fleet } from "./Ui2Fleet";
import { Ui2I18nProvider } from "../../i18n/Ui2I18n";
import { useCompany } from "@/context/CompanyContext";

const mockFleetApi = vi.hoisted(() => ({ dashboard: vi.fn(), sites: vi.fn() }));
vi.mock("@/api/fleet", () => ({ fleetApi: mockFleetApi }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: vi.fn(() => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1" } })),
}));

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("myrmidon(UI2) Ui2Fleet screen parity", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let queryClient: QueryClient;

  async function renderScreen(locale: "en" | "ru" = "en") {
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Ui2I18nProvider initialLocale={locale}>
            <Ui2Fleet />
          </Ui2I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockFleetApi.sites.mockResolvedValue({ sites: [] });
    mockFleetApi.dashboard.mockResolvedValue({
      ok: true,
      generatedAt: "2026-10-20T00:00:00.000Z",
      sources: [],
      hosts: [{ name: "node-a", origin: "victoriametrics", cpuPercent: 12, memoryPercent: 34, diskPercent: 56, ageSec: 10 }],
      containers: [{ name: "worker-a", state: "running", cpuPercent: 1, memoryBytes: 1024 }],
    });
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("loads the dashboard and renders host/service statuses", async () => {
    await renderScreen();
    expect(mockFleetApi.dashboard).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("Servers");
    expect(container.textContent).toContain("node-a");
    expect(container.textContent).toContain("worker-a");
    expect(container.textContent).toContain("Running");
  });

  it("renders the empty state in Russian", async () => {
    mockFleetApi.dashboard.mockResolvedValue({ ok: true, generatedAt: "2026-10-20T00:00:00.000Z", sources: [], hosts: [], containers: [] });
    await renderScreen("ru");
    expect(container.textContent).toContain("Серверы");
    expect(container.textContent).toContain("Ресурсов флота пока нет");
  });

  it("shows monitoring source errors instead of the empty state", async () => {
    mockFleetApi.dashboard.mockResolvedValue({ ok: false, generatedAt: "2026-10-20T00:00:00.000Z", sources: [{ name: "zabbix", ok: false, latency_ms: null, error: "not configured" }], hosts: [], containers: [] });
    await renderScreen();
    expect(container.textContent).toContain("Monitoring is not configured or is unavailable.");
    expect(container.textContent).toContain("not configured");
    expect(container.textContent).not.toContain("No fleet resources yet");
  });

  it("shows the generic monitoring message when ok=false and no source has an error", async () => {
    mockFleetApi.dashboard.mockResolvedValue({ ok: false, generatedAt: "2026-10-20T00:00:00.000Z", sources: [{ name: "zabbix", ok: false, latency_ms: null, error: null }], hosts: [], containers: [] });
    await renderScreen();
    expect(container.textContent).toContain("Monitoring is not configured or is unavailable.");
    expect(container.textContent).toContain("Monitoring data is unavailable.");
    expect(container.textContent).not.toContain("No fleet resources yet");
  });

  it("keeps loading while no company is selected", async () => {
    vi.mocked(useCompany).mockReturnValueOnce({ selectedCompanyId: null, selectedCompany: null } as never);
    await renderScreen();
    expect(mockFleetApi.dashboard).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("No fleet resources yet");
  });

  it("renders an error with a retry action", async () => {
    mockFleetApi.dashboard.mockRejectedValue(new Error("dashboard unavailable"));
    await renderScreen();
    expect(container.textContent).toContain("Could not load this data. Try again.");
    expect(container.textContent).toContain("Retry");
    expect(container.textContent).toContain("dashboard unavailable");
  });

  it("shows a badge per remote site: reachable, automatically drained and quarantined", async () => {
    mockFleetApi.sites.mockResolvedValue({
      sites: [
        { name: "myr-vm1", state: "healthy", status: "active", autoDrained: false, lastSeenAt: "2026-10-23T08:00:00.000Z" },
        { name: "site-b", state: "unreachable", status: "draining", autoDrained: true, lastSeenAt: null },
        { name: "site-c", state: "quarantined", status: "quarantined", autoDrained: false, lastSeenAt: "2026-10-23T07:00:00.000Z" },
      ],
    });
    await renderScreen();
    expect(mockFleetApi.sites).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("Execution sites");
    expect(container.querySelector('[data-testid="site-badge-myr-vm1"]')?.textContent).toBe("Reachable");
    expect(container.querySelector('[data-testid="site-badge-site-b"]')?.textContent).toBe("Unreachable · drained automatically");
    expect(container.querySelector('[data-testid="site-badge-site-c"]')?.textContent).toBe("Quarantined");
    expect(container.textContent).toContain("Has not answered yet");
  });

  it("renders the site badges in Russian", async () => {
    mockFleetApi.sites.mockResolvedValue({
      sites: [{ name: "site-b", state: "draining", status: "draining", autoDrained: false, lastSeenAt: null }],
    });
    await renderScreen("ru");
    expect(container.textContent).toContain("Площадки исполнения");
    expect(container.querySelector('[data-testid="site-badge-site-b"]')?.textContent).toBe("Отвод");
  });

  it("keeps the rest of the screen when the site list fails", async () => {
    mockFleetApi.sites.mockRejectedValue(new Error("sites unavailable"));
    await renderScreen();
    expect(container.textContent).toContain("node-a");
    expect(container.textContent).not.toContain("Execution sites");
  });
});
