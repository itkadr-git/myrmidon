// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteSitesSection, toSiteRow } from "./RemoteSitesSection";
import type { FleetSiteOverview } from "@/api/fleet";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockFleetApi = vi.hoisted(() => ({
  sitesOverview: vi.fn(), siteBots: vi.fn(), drainSite: vi.fn(), resumeSite: vi.fn(), restartBot: vi.fn(),
  stopBot: vi.fn(), moveBot: vi.fn(), botLogs: vi.fn(), enrollSite: vi.fn(),
}));
vi.mock("@/api/fleet", () => ({ fleetApi: mockFleetApi }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: vi.fn(() => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1" } })),
}));

const overview = (overrides: Partial<FleetSiteOverview> = {}): FleetSiteOverview => ({
  name: "myr-vm1", state: "healthy", status: "active", autoDrained: false, lastSeenAt: new Date().toISOString(),
  url: "https://192.0.2.10:9100", labels: {}, clientCertNotAfter: new Date(Date.now() + 90 * 86_400_000).toISOString(), certExpired: false,
  capacity: { cpus: { used: 2, total: 8 }, memoryMb: { used: 2048, total: 32768 }, bots: { used: 2, total: 13 } },
  botCount: 2, driftCount: 0, enrolledAt: "2026-10-20T00:00:00.000Z", ...overrides,
});
const botApi = { botKey: "bot-1", agentName: "work-qa", state: "running", image: "img@sha256:aa", drift: false, driftFields: [], apiBaseUrl: "http://10.10.0.110:18701", gatewayPort: 18701, pinned: false };

let container: HTMLDivElement; let root: Root; let queryClient: QueryClient;
async function flush() { for (let i = 0; i < 6; i += 1) { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); } }
async function mount() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { root.render(<QueryClientProvider client={queryClient}><RemoteSitesSection /></QueryClientProvider>); });
  await flush();
}
async function click(el: Element) { await act(async () => { (el as HTMLElement).click(); }); await flush(); }
function button(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found as HTMLButtonElement;
}

beforeEach(() => {
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  mockFleetApi.sitesOverview.mockResolvedValue({ sites: [overview()] });
  mockFleetApi.siteBots.mockResolvedValue({ site: "myr-vm1", bots: [botApi] });
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.clearAllMocks(); });

describe("toSiteRow", () => {
  it("maps the probe state to the status the table shows; a disabled site stays disabled", () => {
    expect(toSiteRow(overview({ state: "healthy" }), undefined).status).toBe("reachable");
    expect(toSiteRow(overview({ state: "unknown", status: "disabled" }), undefined).status).toBe("disabled");
    expect(toSiteRow(overview({ state: "unreachable", status: "draining", autoDrained: true }), undefined)).toMatchObject({ status: "unreachable", registryStatus: "draining", autoDrained: true });
  });
});

describe("RemoteSitesSection", () => {
  it("loads the overview for the company and renders the site", async () => {
    await mount();
    expect(mockFleetApi.sitesOverview).toHaveBeenCalledWith("company-1");
    expect(container.querySelector('[data-testid="remote-site-myr-vm1"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="remote-site-capacity-myr-vm1"]')?.textContent).toContain("bots 2/13");
  });

  it("loads the bots of a site when it is opened and restarts one by the button", async () => {
    mockFleetApi.restartBot.mockResolvedValue({ ok: true });
    await mount();
    await click(container.querySelector("button[aria-expanded]")!);
    expect(mockFleetApi.siteBots).toHaveBeenCalledWith("company-1", "myr-vm1");
    expect(container.querySelector('[data-testid="remote-bot-bot-1"]')?.textContent).toContain("work-qa");
    await click(button("Restart"));
    expect(mockFleetApi.restartBot).toHaveBeenCalledWith("bot-1");
  });

  it("drains a site and shows the server's refusal under it", async () => {
    mockFleetApi.drainSite.mockRejectedValue(new Error("Site is quarantined"));
    await mount();
    await click(button("Drain"));
    expect(mockFleetApi.drainSite).toHaveBeenCalledWith("company-1", "myr-vm1");
    expect(container.textContent).toContain("The action did not go through: Site is quarantined");
  });

  it("reads and hides a bot log", async () => {
    mockFleetApi.botLogs.mockResolvedValue({ logs: "line one" });
    await mount();
    await click(container.querySelector("button[aria-expanded]")!);
    await click(button("Logs"));
    expect(container.querySelector('[data-testid="remote-bot-logs-bot-1"]')?.textContent).toBe("line one");
    await click(button("Hide logs"));
    expect(container.querySelector('[data-testid="remote-bot-logs-bot-1"]')).toBeNull();
  });

  it("moves a bot to the board host", async () => {
    mockFleetApi.moveBot.mockResolvedValue({ move: { phase: "done" } });
    await mount();
    await click(container.querySelector("button[aria-expanded]")!);
    const select = container.querySelector("select") as HTMLSelectElement;
    await act(async () => { select.value = "local"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await click(button("Move"));
    expect(mockFleetApi.moveBot).toHaveBeenCalledWith("bot-1", "local");
    expect(container.textContent).toContain("Move finished: done");
  });

  it("adds a site from the form and refuses a typo before the request", async () => {
    mockFleetApi.sitesOverview.mockResolvedValue({ sites: [] });
    mockFleetApi.enrollSite.mockResolvedValue({ site: { name: "myr-vm1" } });
    await mount();
    expect(container.textContent).toContain("No sites configured");
    await click(button("Add a site"));
    const set = async (name: string, value: string) => {
      const el = container.querySelector(`[name="${name}"]`)!;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
    };
    await click(button("Add site"));
    expect(container.querySelector('[data-testid="remote-site-enroll-problem"]')?.textContent).toBe("Fill in the field: Site name");
    expect(mockFleetApi.enrollSite).not.toHaveBeenCalled();
    await set("name", "myr-vm1"); await set("url", "https://192.0.2.10:9100"); await set("tokenSecret", "fleetd-token");
    await set("clientCertSecretKey", "fleetd-client"); await set("caCert", "-----BEGIN CERTIFICATE-----\nAA\n-----END CERTIFICATE-----");
    await set("maxCpus", "8"); await set("maxMemoryMb", "32768");
    await click(button("Add site"));
    expect(mockFleetApi.enrollSite).toHaveBeenCalledWith("company-1", expect.objectContaining({ name: "myr-vm1", capacity: { maxCpus: 8, maxMemoryMb: 32768 }, gatewayPortStart: 18700, gatewayPortEnd: 18759 }));
    expect(container.textContent).toContain("Site myr-vm1 added");
  });

  it("shows an enroll refusal as received", async () => {
    mockFleetApi.sitesOverview.mockResolvedValue({ sites: [] });
    mockFleetApi.enrollSite.mockRejectedValue(new Error("tokenSecret: company secret \"x\" not found"));
    await mount();
    await click(button("Add a site"));
    const set = async (name: string, value: string) => {
      const el = container.querySelector(`[name="${name}"]`)!;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
    };
    await set("name", "s1"); await set("url", "https://h:9100"); await set("tokenSecret", "x"); await set("clientCertSecretKey", "c");
    await set("caCert", "pem"); await set("maxCpus", "1"); await set("maxMemoryMb", "1024");
    await click(button("Add site"));
    expect(container.textContent).toContain("company secret \"x\" not found");
  });
});
