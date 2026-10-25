// ui/src/ui2/screens/fleet/Ui2Fleet.myrmidon.test.tsx
// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ui2Fleet } from "./Ui2Fleet";
import { Ui2I18nProvider } from "../../i18n/Ui2I18n";
import { useCompany } from "@/context/CompanyContext";

const mockFleetApi = vi.hoisted(() => ({
  dashboard: vi.fn(),
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
    mockFleetApi.sitesOverview.mockResolvedValue({ sites: [] });
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
    mockFleetApi.dashboard.mockResolvedValue({ ok: false, generatedAt: "2026-10-20T00:00:00.000Z", sources: [], hosts: [], containers: [] });
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

  const farFuture = new Date(Date.now() + 90 * 86_400_000).toISOString();
  function siteRow(overrides: Record<string, unknown> = {}) {
    return {
      name: "myr-vm1",
      state: "healthy",
      status: "active",
      autoDrained: false,
      lastSeenAt: "2026-10-23T08:00:00.000Z",
      url: "https://192.0.2.10:9100",
      labels: {},
      clientCertNotAfter: farFuture,
      certExpired: false,
      capacity: { cpus: { used: 2, total: 8 }, memoryMb: { used: 2048, total: 32768 }, bots: { used: 2, total: 13 } },
      botCount: 2,
      driftCount: 1,
      enrolledAt: "2026-10-20T00:00:00.000Z",
      ...overrides,
    };
  }
  const botRow = { botKey: "bot-1", agentName: "work-qa", state: "running", image: "img@sha256:aa", drift: true, driftFields: ["HostConfig.Binds"], apiBaseUrl: "http://192.0.2.20:18701", gatewayPort: 18701, pinned: false };

  function buttonByText(text: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === text);
    if (!found) throw new Error(`no button "${text}"`);
    return found as HTMLButtonElement;
  }
  async function click(el: Element) {
    flushSync(() => (el as HTMLElement).click());
    await flushReact();
  }
  async function setValue(el: Element, value: string) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
    flushSync(() => {
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();
  }

  it("shows a badge per remote site: reachable, automatically drained and quarantined", async () => {
    mockFleetApi.sitesOverview.mockResolvedValue({
      sites: [
        siteRow(),
        siteRow({ name: "site-b", state: "unreachable", status: "draining", autoDrained: true, lastSeenAt: null }),
        siteRow({ name: "site-c", state: "quarantined", status: "quarantined", lastSeenAt: "2026-10-23T07:00:00.000Z" }),
      ],
    });
    await renderScreen();
    expect(mockFleetApi.sitesOverview).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("Execution sites");
    expect(container.querySelector('[data-testid="site-badge-myr-vm1"]')?.textContent).toBe("Reachable");
    expect(container.querySelector('[data-testid="site-badge-site-b"]')?.textContent).toBe("Unreachable · drained automatically");
    expect(container.querySelector('[data-testid="site-badge-site-c"]')?.textContent).toBe("Quarantined");
    expect(container.textContent).toContain("Has not answered yet");
  });

  it("shows capacity used/total, drift and the key lifetime of a site", async () => {
    mockFleetApi.sitesOverview.mockResolvedValue({ sites: [siteRow()] });
    await renderScreen();
    expect(container.querySelector('[data-testid="site-capacity-myr-vm1"]')?.textContent).toBe("CPU 2/8 · memory 2048/32768 MB · bots 2/13");
    expect(container.querySelector('[data-testid="site-drift-myr-vm1"]')?.textContent).toBe("Drift: 1");
    expect(container.querySelector('[data-testid="site-cert-myr-vm1"]')?.textContent).toContain("Key valid until");
    expect(container.querySelector('[data-testid="site-cert-myr-vm1"]')?.getAttribute("role")).toBeNull();
  });

  it("raises an alert for an expired key and refuses the actions", async () => {
    mockFleetApi.sitesOverview.mockResolvedValue({
      sites: [siteRow({ status: "draining", state: "draining", clientCertNotAfter: "2026-10-01T00:00:00.000Z", certExpired: true })],
    });
    mockFleetApi.siteBots.mockResolvedValue({ site: "myr-vm1", bots: [botRow] });
    await renderScreen();
    const cert = container.querySelector('[data-testid="site-cert-myr-vm1"]')!;
    expect(cert.getAttribute("role")).toBe("alert");
    expect(cert.textContent).toContain("Key expired");
    expect(buttonByText("Resume").disabled).toBe(true);
    await click(buttonByText("Show bots"));
    expect(buttonByText("Restart").disabled).toBe(true);
    expect(buttonByText("Stop").disabled).toBe(true);
  });

  it("lists the bots of a site and restarts one with the button", async () => {
    mockFleetApi.sitesOverview.mockResolvedValue({ sites: [siteRow()] });
    mockFleetApi.siteBots.mockResolvedValue({ site: "myr-vm1", bots: [botRow] });
    mockFleetApi.restartBot.mockResolvedValue({ ok: true });
    await renderScreen();
    await click(buttonByText("Show bots"));
    expect(mockFleetApi.siteBots).toHaveBeenCalledWith("company-1", "myr-vm1");
    expect(container.querySelector('[data-testid="site-bots-myr-vm1"]')?.textContent).toContain("work-qa");
    expect(container.querySelector('[data-testid="bot-drift-bot-1"]')?.textContent).toBe("Drift: HostConfig.Binds");
    await click(buttonByText("Restart"));
    expect(mockFleetApi.restartBot).toHaveBeenCalledWith("bot-1");
  });

  it("stops a bot only after the confirmation, and shows the server's refusal", async () => {
    mockFleetApi.sitesOverview.mockResolvedValue({ sites: [siteRow()] });
    mockFleetApi.siteBots.mockResolvedValue({ site: "myr-vm1", bots: [botRow] });
    mockFleetApi.stopBot.mockRejectedValue(new Error("Site is quarantined"));
    await renderScreen();
    await click(buttonByText("Show bots"));
    await click(buttonByText("Stop"));
    expect(mockFleetApi.stopBot).not.toHaveBeenCalled();
    await click(buttonByText("Confirm stop"));
    expect(mockFleetApi.stopBot).toHaveBeenCalledWith("bot-1");
    expect(container.textContent).toContain("The action did not go through: Site is quarantined");
  });

  it("moves a bot to another site or the board host, and reads its log", async () => {
    mockFleetApi.sitesOverview.mockResolvedValue({ sites: [siteRow(), siteRow({ name: "site-b" })] });
    mockFleetApi.siteBots.mockResolvedValue({ site: "myr-vm1", bots: [botRow] });
    mockFleetApi.moveBot.mockResolvedValue({ move: { phase: "done" } });
    mockFleetApi.botLogs.mockResolvedValue({ logs: "line one" });
    await renderScreen();
    await click(container.querySelector('[data-testid="site-myr-vm1"] button[aria-expanded]')!);
    const select = container.querySelector('[data-testid="bot-bot-1"] select') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["", "site-b", "local"]);
    expect(buttonByText("Move").disabled).toBe(true);
    flushSync(() => {
      select.value = "site-b";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();
    await click(buttonByText("Move"));
    expect(mockFleetApi.moveBot).toHaveBeenCalledWith("bot-1", "site-b");
    expect(container.textContent).toContain("Move finished: done");
    await click(buttonByText("Logs"));
    expect(mockFleetApi.botLogs).toHaveBeenCalledWith("bot-1");
    expect(container.querySelector('[data-testid="bot-logs-bot-1"]')?.textContent).toBe("line one");
  });

  it("drains an active site and resumes a draining one", async () => {
    mockFleetApi.sitesOverview.mockResolvedValue({ sites: [siteRow(), siteRow({ name: "site-b", status: "draining", state: "draining" })] });
    mockFleetApi.drainSite.mockResolvedValue({ status: "draining", changed: true });
    mockFleetApi.resumeSite.mockResolvedValue({ status: "active", changed: true });
    await renderScreen();
    await click(buttonByText("Drain"));
    expect(mockFleetApi.drainSite).toHaveBeenCalledWith("company-1", "myr-vm1");
    await click(buttonByText("Resume"));
    expect(mockFleetApi.resumeSite).toHaveBeenCalledWith("company-1", "site-b");
  });

  it("adds a site from the form and tells a typo before the request", async () => {
    mockFleetApi.enrollSite.mockResolvedValue({ site: { name: "myr-vm1" } });
    await renderScreen();
    await click(buttonByText("Add a site"));
    const field = (name: string) => container.querySelector(`[data-testid="add-site-form"] [name="${name}"]`)!;
    await click(buttonByText("Add site"));
    expect(container.querySelector('[data-testid="add-site-problem"]')?.textContent).toBe("Fill in the field: Site name");
    expect(mockFleetApi.enrollSite).not.toHaveBeenCalled();
    await setValue(field("name"), "myr-vm1");
    await setValue(field("url"), "https://192.0.2.10:9100");
    await setValue(field("tokenSecret"), "fleetd-token");
    await setValue(field("clientCertSecretKey"), "fleetd-client");
    await setValue(container.querySelector("textarea")!, "-----BEGIN CERTIFICATE-----\nAA\n-----END CERTIFICATE-----");
    await setValue(field("maxCpus"), "8");
    await setValue(field("maxMemoryMb"), "32768");
    await click(buttonByText("Add site"));
    expect(mockFleetApi.enrollSite).toHaveBeenCalledWith("company-1", {
      name: "myr-vm1",
      url: "https://192.0.2.10:9100",
      tokenSecret: "fleetd-token",
      caCert: "-----BEGIN CERTIFICATE-----\nAA\n-----END CERTIFICATE-----",
      clientCertSecretKey: "fleetd-client",
      capacity: { maxCpus: 8, maxMemoryMb: 32768 },
      gatewayPortStart: 18700,
      gatewayPortEnd: 18759,
    });
    expect(container.textContent).toContain("Site myr-vm1 added");
  });

  it("renders the site screen in Russian", async () => {
    mockFleetApi.sitesOverview.mockResolvedValue({ sites: [siteRow({ name: "site-b", state: "draining", status: "draining", lastSeenAt: null })] });
    await renderScreen("ru");
    expect(container.textContent).toContain("Площадки исполнения");
    expect(container.querySelector('[data-testid="site-badge-site-b"]')?.textContent).toBe("Отвод");
    expect(container.querySelector('[data-testid="site-capacity-site-b"]')?.textContent).toBe("ЦП 2/8 · память 2048/32768 МБ · боты 2/13");
    expect(buttonByText("Вернуть")).toBeTruthy();
    expect(buttonByText("Добавить площадку")).toBeTruthy();
  });

  it("keeps the rest of the screen when the site list fails", async () => {
    mockFleetApi.sitesOverview.mockRejectedValue(new Error("sites unavailable"));
    await renderScreen();
    expect(container.textContent).toContain("node-a");
    expect(container.querySelector('[data-testid^="site-badge-"]')).toBeNull();
  });
});
