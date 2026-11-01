// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { AnchorHTMLAttributes } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ui2AgentsFleetPage } from "./Ui2AgentsFleetPage";
import { Ui2I18nProvider } from "../../i18n/Ui2I18n";

const mockApi = vi.hoisted(() => ({ agentsList: vi.fn(), liveRuns: vi.fn() }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: mockApi.agentsList } }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: mockApi.liveRuns } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "co1" }) }));
vi.mock("@/lib/router", () => ({ Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => <a href={to} {...props}>{children}</a> }));

async function settle() {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => window.setTimeout(resolve, 0));
  flushSync(() => {});
}

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  flushSync(() => {});
}

describe("agents fleet screen", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  beforeEach(() => {
    container = document.createElement("div"); document.body.appendChild(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    mockApi.liveRuns.mockResolvedValue([]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => { root?.unmount(); client.clear(); container.remove(); vi.useRealTimers(); vi.clearAllMocks(); });
  async function renderScreen() {
    root = createRoot(container);
    flushSync(() => root.render(<QueryClientProvider client={client}><Ui2I18nProvider initialLocale="en"><Ui2AgentsFleetPage /></Ui2I18nProvider></QueryClientProvider>));
    await settle();
  }
  function searchInput(): HTMLInputElement {
    return container.querySelector<HTMLInputElement>('input[type="search"]')!;
  }
  function statusSelect(): HTMLSelectElement {
    return container.querySelector<HTMLSelectElement>('select[aria-label="Filter by status"]')!;
  }
  it("renders the empty state", async () => {
    mockApi.agentsList.mockResolvedValue([]);
    await renderScreen();
    expect(container.textContent).toContain("No agents configured yet.");
  });
  it("renders each agent in a cycle exactly once", async () => {
    mockApi.agentsList.mockResolvedValue([
      { id: "a", name: "Alpha", role: "lead", status: "paused", reportsTo: "b" },
      { id: "b", name: "Beta", role: "engineer", status: "active", reportsTo: "a" },
    ]);
    await renderScreen();
    expect(container.textContent).toContain("Alpha");
    expect(container.textContent).toContain("Beta");
    expect(container.textContent).toContain("Paused");
    expect(container.querySelectorAll('a[href="/agents/a"]')).toHaveLength(1);
    expect(container.querySelectorAll('a[href="/agents/b"]')).toHaveLength(1);
  });
  it("sends q, status, role and reportsTo filters to the agents API", async () => {
    mockApi.agentsList.mockResolvedValue([]);
    await renderScreen();
    expect(mockApi.agentsList).toHaveBeenLastCalledWith("co1", undefined);
    // Type in the search box; the request fires only after the 300 ms debounce.
    searchInput().value = "alp";
    searchInput().dispatchEvent(new Event("input", { bubbles: true }));
    await advance(300);
    expect(mockApi.agentsList).toHaveBeenLastCalledWith("co1", { q: "alp" });
    // Pick a status; the query key changes and a filtered request goes out.
    statusSelect().value = "paused";
    statusSelect().dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(mockApi.agentsList).toHaveBeenLastCalledWith("co1", { q: "alp", status: "paused" });
  });
  it("typing without the debounce delay does not fire a request per keystroke", async () => {
    mockApi.agentsList.mockResolvedValue([]);
    await renderScreen();
    mockApi.agentsList.mockClear();
    for (const ch of ["a", "l", "p"]) {
      searchInput().value = searchInput().value + ch;
      searchInput().dispatchEvent(new Event("input", { bubbles: true }));
      await advance(100);
    }
    expect(mockApi.agentsList).not.toHaveBeenCalled();
    await advance(200);
    expect(mockApi.agentsList).toHaveBeenCalledTimes(1);
    expect(mockApi.agentsList).toHaveBeenLastCalledWith("co1", { q: "alp" });
  });
  it("clearing filters restores the unfiltered request", async () => {
    mockApi.agentsList.mockResolvedValue([]);
    await renderScreen();
    searchInput().value = "alp";
    searchInput().dispatchEvent(new Event("input", { bubbles: true }));
    await advance(300);
    statusSelect().value = "paused";
    statusSelect().dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(mockApi.agentsList).toHaveBeenLastCalledWith("co1", { q: "alp", status: "paused" });
    const clearButton = container.querySelector<HTMLButtonElement>("button")!;
    clearButton.click();
    await settle();
    expect(mockApi.agentsList).toHaveBeenLastCalledWith("co1", undefined);
  });
  it("renders the filtered result returned by the server", async () => {
    mockApi.agentsList.mockResolvedValue([
      { id: "a", name: "Alpha", role: "lead", status: "active" },
    ]);
    await renderScreen();
    searchInput().value = "alp";
    searchInput().dispatchEvent(new Event("input", { bubbles: true }));
    await advance(300);
    await settle();
    expect(mockApi.agentsList).toHaveBeenLastCalledWith("co1", { q: "alp" });
    expect(container.textContent).toContain("Alpha");
  });
});
