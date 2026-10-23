// ui/src/ui2/screens/fleet/Ui2Fleet.myrmidon.test.tsx
// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ui2Fleet } from "./Ui2Fleet";
import { Ui2I18nProvider } from "../../i18n/Ui2I18n";

const mockFleetApi = vi.hoisted(() => ({ dashboard: vi.fn() }));
vi.mock("@/api/fleet", () => ({ fleetApi: mockFleetApi }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1" } }),
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
    expect(container.textContent).toContain("Server fleet");
    expect(container.textContent).toContain("node-a");
    expect(container.textContent).toContain("worker-a");
    expect(container.textContent).toContain("Running");
  });

  it("renders the empty state in Russian", async () => {
    mockFleetApi.dashboard.mockResolvedValue({ ok: true, generatedAt: "2026-10-20T00:00:00.000Z", sources: [], hosts: [], containers: [] });
    await renderScreen("ru");
    expect(container.textContent).toContain("Флот серверов");
    expect(container.textContent).toContain("Ресурсов флота пока нет");
  });

  it("renders an error with a retry action", async () => {
    mockFleetApi.dashboard.mockRejectedValue(new Error("dashboard unavailable"));
    await renderScreen();
    expect(container.textContent).toContain("Could not load this data. Try again.");
    expect(container.textContent).toContain("Retry");
    expect(container.textContent).toContain("dashboard unavailable");
  });
});
